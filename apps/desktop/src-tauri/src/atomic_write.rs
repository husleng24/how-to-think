use chrono::Utc;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

pub fn write_file_atomically(path: &Path, content: &[u8]) -> io::Result<()> {
    let parent = path.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "atomic write target must have a parent directory",
        )
    })?;

    let (temp_path, temp_file) = create_temp_file(parent, path)?;
    let result = write_and_replace(&temp_path, temp_file, path, content)
        .and_then(|_| sync_parent_directory(parent));

    if result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }

    result
}

fn write_and_replace(
    temp_path: &Path,
    mut temp_file: File,
    target_path: &Path,
    content: &[u8],
) -> io::Result<()> {
    temp_file.write_all(content)?;
    temp_file.sync_all()?;
    drop(temp_file);
    replace_file(temp_path, target_path)
}

fn create_temp_file(parent: &Path, target_path: &Path) -> io::Result<(PathBuf, File)> {
    let target_name = target_path.file_name().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "atomic write target must have a file name",
        )
    })?;
    let target_name = target_name.to_string_lossy();
    let timestamp = Utc::now()
        .timestamp_nanos_opt()
        .unwrap_or_else(|| Utc::now().timestamp_millis());

    for attempt in 0..100 {
        let candidate = parent.join(format!(
            ".{target_name}.{}.{}.{}.tmp",
            std::process::id(),
            timestamp,
            attempt
        ));
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(file) => return Ok((candidate, file)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }

    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "could not create a unique temporary file for atomic write",
    ))
}

#[cfg(windows)]
fn replace_file(from: &Path, to: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let from_wide: Vec<u16> = from
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let to_wide: Vec<u16> = to
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let flags = MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH;
    let moved = unsafe { MoveFileExW(from_wide.as_ptr(), to_wide.as_ptr(), flags) };

    if moved == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_file(from: &Path, to: &Path) -> io::Result<()> {
    fs::rename(from, to)
}

#[cfg(unix)]
fn sync_parent_directory(parent: &Path) -> io::Result<()> {
    File::open(parent)?.sync_all()
}

#[cfg(not(unix))]
fn sync_parent_directory(_parent: &Path) -> io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_new_file() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("note.md");

        write_file_atomically(&path, b"# Note").unwrap();

        assert_eq!(fs::read_to_string(path).unwrap(), "# Note");
    }

    #[test]
    fn replaces_existing_file() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("note.md");
        fs::write(&path, "old").unwrap();

        write_file_atomically(&path, b"new").unwrap();

        assert_eq!(fs::read_to_string(&path).unwrap(), "new");
        let leftovers: Vec<_> = fs::read_dir(temp.path())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty());
    }
}
