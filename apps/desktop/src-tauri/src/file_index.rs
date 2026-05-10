use crate::errors::{WorkspaceError, WorkspaceErrorCode, WorkspaceOperation};
use crate::models::{FileVersion, WorkspaceFile, WorkspaceRelativePath};
use crate::path_guard::{supported_markdown_extension, validate_workspace_relative_path};
use crate::time_utils::system_time_to_iso;
use sha2::{Digest, Sha256};
use std::fs::{self, File, Metadata};
use std::io::Read;
use std::path::{Component, Path};

const SKIPPED_DIRECTORIES: &[&str] = &[".git", "node_modules", "dist", "target", ".tauri"];

pub fn index_markdown_files(
    workspace_root: &Path,
    case_sensitive: bool,
) -> Result<Vec<WorkspaceFile>, WorkspaceError> {
    let canonical_root = fs::canonicalize(workspace_root).map_err(|error| {
        WorkspaceError::new(
            WorkspaceErrorCode::InvalidWorkspacePath,
            WorkspaceOperation::ListFiles,
            "The workspace path cannot be canonicalized.",
            true,
        )
        .with_detail("source", error.to_string())
    })?;

    let mut files = Vec::new();
    visit_directory(&canonical_root, &canonical_root, case_sensitive, &mut files)?;
    files.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    Ok(files)
}

fn visit_directory(
    canonical_root: &Path,
    directory: &Path,
    case_sensitive: bool,
    files: &mut Vec<WorkspaceFile>,
) -> Result<(), WorkspaceError> {
    let entries = fs::read_dir(directory)
        .map_err(|error| WorkspaceError::from_io(WorkspaceOperation::ListFiles, None, &error))?;

    for entry in entries {
        let entry = entry.map_err(|error| {
            WorkspaceError::from_io(WorkspaceOperation::ListFiles, None, &error)
        })?;
        let entry_path = entry.path();
        let file_type = entry.file_type().map_err(|error| {
            WorkspaceError::from_io(WorkspaceOperation::ListFiles, None, &error)
        })?;
        let file_name = entry.file_name();
        let file_name = file_name.to_string_lossy();

        if file_type.is_dir() {
            if should_skip_directory(&file_name) {
                continue;
            }
            visit_directory(canonical_root, &entry_path, case_sensitive, files)?;
            continue;
        }

        if !(file_type.is_file() || file_type.is_symlink()) {
            continue;
        }

        if supported_markdown_extension(&file_name, case_sensitive).is_none() {
            continue;
        }

        let canonical_entry = fs::canonicalize(&entry_path).map_err(|error| {
            WorkspaceError::from_io(WorkspaceOperation::ListFiles, None, &error)
        })?;
        if !canonical_entry.starts_with(canonical_root) {
            continue;
        }

        let relative_path =
            workspace_relative_path(canonical_root, &entry_path).ok_or_else(|| {
                WorkspaceError::new(
                    WorkspaceErrorCode::PathOutsideWorkspace,
                    WorkspaceOperation::ListFiles,
                    "The indexed path is outside the selected workspace.",
                    true,
                )
            })?;
        let relative_path = validate_workspace_relative_path(
            &relative_path,
            case_sensitive,
            WorkspaceOperation::ListFiles,
        )?;
        let metadata = fs::metadata(&entry_path).map_err(|error| {
            WorkspaceError::from_io(WorkspaceOperation::ListFiles, Some(&relative_path), &error)
        })?;

        if metadata.is_file() {
            files.push(workspace_file(&entry_path, &relative_path, &metadata)?);
        }
    }

    Ok(())
}

fn workspace_file(
    path: &Path,
    relative_path: &WorkspaceRelativePath,
    metadata: &Metadata,
) -> Result<WorkspaceFile, WorkspaceError> {
    let modified_at = metadata
        .modified()
        .map(system_time_to_iso)
        .map_err(|error| {
            WorkspaceError::from_io(WorkspaceOperation::ListFiles, Some(relative_path), &error)
        })?;
    let byte_size = metadata.len();
    let content_hash = hash_file(path, relative_path)?;
    let token = format!(
        "{modified_at}:{byte_size}:{hash}",
        hash = &content_hash[..16]
    );
    let name = Path::new(relative_path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(relative_path)
        .to_owned();
    let extension = supported_markdown_extension(&name, false)
        .unwrap_or(".md")
        .to_owned();

    Ok(WorkspaceFile {
        relative_path: relative_path.clone(),
        name,
        extension,
        byte_size,
        modified_at: modified_at.clone(),
        version: FileVersion {
            modified_at,
            byte_size,
            content_hash,
            token,
        },
    })
}

fn hash_file(path: &Path, relative_path: &str) -> Result<String, WorkspaceError> {
    let mut file = File::open(path).map_err(|error| {
        WorkspaceError::from_io(WorkspaceOperation::ListFiles, Some(relative_path), &error)
    })?;
    let mut hasher = Sha256::new();
    let mut buffer = [0; 8192];

    loop {
        let bytes_read = file.read(&mut buffer).map_err(|error| {
            WorkspaceError::from_io(WorkspaceOperation::ListFiles, Some(relative_path), &error)
        })?;
        if bytes_read == 0 {
            break;
        }
        hasher.update(&buffer[..bytes_read]);
    }

    Ok(format!("{:x}", hasher.finalize()))
}

fn workspace_relative_path(canonical_root: &Path, path: &Path) -> Option<String> {
    let relative_path = path.strip_prefix(canonical_root).ok()?;
    let mut segments = Vec::new();

    for component in relative_path.components() {
        match component {
            Component::Normal(segment) => segments.push(segment.to_str()?.to_owned()),
            _ => return None,
        }
    }

    Some(segments.join("/"))
}

fn should_skip_directory(file_name: &str) -> bool {
    SKIPPED_DIRECTORIES
        .iter()
        .any(|skipped| skipped.eq_ignore_ascii_case(file_name))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn indexes_markdown_files_and_skips_implementation_directories() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        fs::create_dir_all(root.join("notes")).unwrap();
        fs::create_dir_all(root.join("target")).unwrap();
        fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        fs::write(root.join("README.md"), "# Root").unwrap();
        fs::write(root.join("notes/idea.markdown"), "# Idea").unwrap();
        fs::write(root.join("notes/ignore.txt"), "not markdown").unwrap();
        fs::write(root.join("target/generated.md"), "# Build output").unwrap();
        fs::write(root.join("node_modules/pkg/readme.md"), "# Dependency").unwrap();

        let files = index_markdown_files(root, true).unwrap();
        let paths: Vec<_> = files
            .iter()
            .map(|file| file.relative_path.as_str())
            .collect();

        assert_eq!(paths, vec!["README.md", "notes/idea.markdown"]);
        assert!(files
            .iter()
            .all(|file| file.version.content_hash.len() == 64));
    }

    #[test]
    fn indexes_case_insensitive_extensions_when_requested() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        fs::write(root.join("idea.MD"), "# Idea").unwrap();

        assert!(index_markdown_files(root, true).unwrap().is_empty());
        assert_eq!(index_markdown_files(root, false).unwrap().len(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn skips_symlink_escapes() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("workspace");
        let outside = temp.path().join("outside.md");
        fs::create_dir_all(&root).unwrap();
        fs::write(&outside, "# Outside").unwrap();
        symlink(&outside, root.join("outside.md")).unwrap();

        let files = index_markdown_files(&root, true).unwrap();
        assert!(files.is_empty());
    }
}
