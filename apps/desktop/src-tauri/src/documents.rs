use crate::atomic_write::write_file_atomically;
use crate::errors::{WorkspaceError, WorkspaceErrorCode, WorkspaceOperation};
use crate::file_index::index_markdown_files;
use crate::models::{
    DeleteDocumentResult, DocumentSnapshot, FileVersion, RenameDocumentResult, SaveRequest,
    SaveResult, WorkspaceFile, WorkspaceRecord, WorkspaceRelativePath,
};
use crate::path_guard::{
    relative_path_to_path_buf, resolve_existing_markdown_file, supported_markdown_extension,
    validate_workspace_relative_path,
};
use crate::time_utils::{now_iso, system_time_to_iso};
use sha2::{Digest, Sha256};
use std::fs::{self, File, Metadata};
use std::io::{self, Read};
use std::path::{Path, PathBuf};

pub fn create_document(
    record: &WorkspaceRecord,
    relative_path: &str,
    content: Option<String>,
) -> Result<DocumentSnapshot, WorkspaceError> {
    ensure_writable(record, WorkspaceOperation::CreateFile)?;
    let resolved =
        resolve_new_document_path(record, relative_path, WorkspaceOperation::CreateFile)?;
    let content = content.unwrap_or_default();

    write_file_atomically(&resolved.absolute_path, content.as_bytes()).map_err(|error| {
        write_error(
            WorkspaceOperation::CreateFile,
            &resolved.relative_path,
            &error,
        )
    })?;

    let version = file_version(
        &resolved.absolute_path,
        &resolved.relative_path,
        WorkspaceOperation::CreateFile,
    )?;

    Ok(DocumentSnapshot {
        workspace_id: record.info.id.clone(),
        relative_path: resolved.relative_path,
        content,
        version,
        opened_at: now_iso(),
    })
}

pub fn open_document(
    record: &WorkspaceRecord,
    relative_path: &str,
) -> Result<DocumentSnapshot, WorkspaceError> {
    let resolved = resolve_existing_markdown_file(
        &record.canonical_root,
        relative_path,
        record.info.case_sensitive,
        WorkspaceOperation::OpenFile,
    )?;
    let content_bytes = fs::read(&resolved.absolute_path).map_err(|error| {
        WorkspaceError::from_io(
            WorkspaceOperation::OpenFile,
            Some(&resolved.relative_path),
            &error,
        )
    })?;
    let content = String::from_utf8(content_bytes).map_err(|error| {
        WorkspaceError::new(
            WorkspaceErrorCode::InvalidUtf8,
            WorkspaceOperation::OpenFile,
            "The Markdown file is not valid UTF-8.",
            true,
        )
        .with_relative_path(resolved.relative_path.as_str())
        .with_detail("source", error.to_string())
    })?;
    let version = file_version(
        &resolved.absolute_path,
        &resolved.relative_path,
        WorkspaceOperation::OpenFile,
    )?;

    Ok(DocumentSnapshot {
        workspace_id: record.info.id.clone(),
        relative_path: resolved.relative_path,
        content,
        version,
        opened_at: now_iso(),
    })
}

pub fn save_document(
    record: &WorkspaceRecord,
    request: SaveRequest,
) -> Result<SaveResult, WorkspaceError> {
    ensure_workspace_matches(record, &request.workspace_id, WorkspaceOperation::SaveFile)?;
    ensure_writable(record, WorkspaceOperation::SaveFile)?;
    let resolved = resolve_existing_markdown_file(
        &record.canonical_root,
        &request.relative_path,
        record.info.case_sensitive,
        WorkspaceOperation::SaveFile,
    )?;
    let current_version = file_version(
        &resolved.absolute_path,
        &resolved.relative_path,
        WorkspaceOperation::SaveFile,
    )?;
    ensure_expected_version(
        WorkspaceOperation::SaveFile,
        &resolved.relative_path,
        &request.expected_version,
        &current_version,
    )?;

    write_file_atomically(&resolved.absolute_path, request.content.as_bytes()).map_err(
        |error| {
            write_error(
                WorkspaceOperation::SaveFile,
                &resolved.relative_path,
                &error,
            )
        },
    )?;

    let version = file_version(
        &resolved.absolute_path,
        &resolved.relative_path,
        WorkspaceOperation::SaveFile,
    )?;

    Ok(SaveResult {
        workspace_id: record.info.id.clone(),
        relative_path: resolved.relative_path,
        byte_size: version.byte_size,
        version,
        saved_at: now_iso(),
    })
}

pub fn rename_document(
    record: &WorkspaceRecord,
    relative_path: &str,
    new_relative_path: &str,
    expected_version: Option<FileVersion>,
) -> Result<RenameDocumentResult, WorkspaceError> {
    ensure_writable(record, WorkspaceOperation::RenameFile)?;
    let source = resolve_existing_markdown_file(
        &record.canonical_root,
        relative_path,
        record.info.case_sensitive,
        WorkspaceOperation::RenameFile,
    )?;

    if let Some(expected_version) = expected_version {
        let current_version = file_version(
            &source.absolute_path,
            &source.relative_path,
            WorkspaceOperation::RenameFile,
        )?;
        ensure_expected_version(
            WorkspaceOperation::RenameFile,
            &source.relative_path,
            &expected_version,
            &current_version,
        )?;
    }

    let destination =
        resolve_new_document_path(record, new_relative_path, WorkspaceOperation::RenameFile)?;
    fs::rename(&source.absolute_path, &destination.absolute_path).map_err(|error| {
        rename_error(&destination.relative_path, &error)
            .with_detail("sourceRelativePath", source.relative_path.clone())
    })?;

    let file = workspace_file(
        &destination.absolute_path,
        &destination.relative_path,
        WorkspaceOperation::RenameFile,
    )?;
    let files = index_markdown_files(&record.canonical_root, record.info.case_sensitive)?;

    Ok(RenameDocumentResult {
        workspace_id: record.info.id.clone(),
        relative_path: source.relative_path,
        new_relative_path: destination.relative_path,
        file,
        files,
        renamed_at: now_iso(),
    })
}

pub fn delete_document(
    record: &WorkspaceRecord,
    relative_path: &str,
    expected_version: Option<FileVersion>,
) -> Result<DeleteDocumentResult, WorkspaceError> {
    ensure_writable(record, WorkspaceOperation::DeleteFile)?;
    let resolved = resolve_existing_markdown_file(
        &record.canonical_root,
        relative_path,
        record.info.case_sensitive,
        WorkspaceOperation::DeleteFile,
    )?;

    if let Some(expected_version) = expected_version {
        let current_version = file_version(
            &resolved.absolute_path,
            &resolved.relative_path,
            WorkspaceOperation::DeleteFile,
        )?;
        ensure_expected_version(
            WorkspaceOperation::DeleteFile,
            &resolved.relative_path,
            &expected_version,
            &current_version,
        )?;
    }

    fs::remove_file(&resolved.absolute_path)
        .map_err(|error| delete_error(&resolved.relative_path, &error))?;
    let files = index_markdown_files(&record.canonical_root, record.info.case_sensitive)?;

    Ok(DeleteDocumentResult {
        workspace_id: record.info.id.clone(),
        relative_path: resolved.relative_path,
        files,
        deleted_at: now_iso(),
    })
}

#[derive(Debug, Clone)]
struct NewDocumentPath {
    relative_path: WorkspaceRelativePath,
    absolute_path: PathBuf,
}

fn resolve_new_document_path(
    record: &WorkspaceRecord,
    relative_path: &str,
    operation: WorkspaceOperation,
) -> Result<NewDocumentPath, WorkspaceError> {
    let relative_path =
        validate_workspace_relative_path(relative_path, record.info.case_sensitive, operation)?;
    let target = record
        .canonical_root
        .join(relative_path_to_path_buf(&relative_path));
    let parent = target.parent().ok_or_else(|| {
        WorkspaceError::new(
            WorkspaceErrorCode::InvalidRelativePath,
            operation,
            "The target Markdown file must have a parent directory.",
            true,
        )
        .with_relative_path(relative_path.as_str())
    })?;
    let canonical_parent = fs::canonicalize(parent)
        .map_err(|error| WorkspaceError::from_io(operation, Some(&relative_path), &error))?;

    if !canonical_parent.starts_with(&record.canonical_root) {
        return Err(WorkspaceError::new(
            WorkspaceErrorCode::PathOutsideWorkspace,
            operation,
            "The resolved path is outside the selected workspace.",
            true,
        )
        .with_relative_path(relative_path));
    }

    match fs::symlink_metadata(&target) {
        Ok(_) => {
            return Err(WorkspaceError::new(
                WorkspaceErrorCode::FileAlreadyExists,
                operation,
                "A Markdown file already exists at the requested path.",
                true,
            )
            .with_relative_path(relative_path));
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(WorkspaceError::from_io(
                operation,
                Some(&relative_path),
                &error,
            ));
        }
    }

    let file_name = target.file_name().ok_or_else(|| {
        WorkspaceError::new(
            WorkspaceErrorCode::InvalidRelativePath,
            operation,
            "The target Markdown file must have a file name.",
            true,
        )
        .with_relative_path(relative_path.as_str())
    })?;

    Ok(NewDocumentPath {
        relative_path,
        absolute_path: canonical_parent.join(file_name),
    })
}

fn ensure_workspace_matches(
    record: &WorkspaceRecord,
    workspace_id: &str,
    operation: WorkspaceOperation,
) -> Result<(), WorkspaceError> {
    if record.info.id == workspace_id {
        return Ok(());
    }

    Err(WorkspaceError::new(
        WorkspaceErrorCode::WorkspaceNotSelected,
        operation,
        "The requested workspace id does not match the stored workspace path.",
        true,
    ))
}

fn ensure_writable(
    record: &WorkspaceRecord,
    operation: WorkspaceOperation,
) -> Result<(), WorkspaceError> {
    if record.info.writable {
        return Ok(());
    }

    Err(WorkspaceError::new(
        WorkspaceErrorCode::WorkspaceUnwritable,
        operation,
        "The selected workspace is not writable.",
        true,
    ))
}

fn ensure_expected_version(
    operation: WorkspaceOperation,
    relative_path: &str,
    expected: &FileVersion,
    current: &FileVersion,
) -> Result<(), WorkspaceError> {
    if expected == current {
        return Ok(());
    }

    Err(WorkspaceError::new(
        WorkspaceErrorCode::VersionConflict,
        operation,
        "The Markdown file changed on disk after it was opened or last saved.",
        true,
    )
    .with_relative_path(relative_path)
    .with_detail("expectedToken", expected.token.clone())
    .with_detail("currentToken", current.token.clone()))
}

fn workspace_file(
    path: &Path,
    relative_path: &WorkspaceRelativePath,
    operation: WorkspaceOperation,
) -> Result<WorkspaceFile, WorkspaceError> {
    let metadata = fs::metadata(path)
        .map_err(|error| WorkspaceError::from_io(operation, Some(relative_path), &error))?;
    if !metadata.is_file() {
        return Err(WorkspaceError::new(
            WorkspaceErrorCode::FileNotFound,
            operation,
            "The requested Markdown file does not exist.",
            true,
        )
        .with_relative_path(relative_path));
    }

    let version = file_version_from_metadata(path, relative_path, operation, &metadata)?;
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
        byte_size: version.byte_size,
        modified_at: version.modified_at.clone(),
        version,
    })
}

fn file_version(
    path: &Path,
    relative_path: &str,
    operation: WorkspaceOperation,
) -> Result<FileVersion, WorkspaceError> {
    let metadata = fs::metadata(path)
        .map_err(|error| WorkspaceError::from_io(operation, Some(relative_path), &error))?;
    file_version_from_metadata(path, relative_path, operation, &metadata)
}

fn file_version_from_metadata(
    path: &Path,
    relative_path: &str,
    operation: WorkspaceOperation,
    metadata: &Metadata,
) -> Result<FileVersion, WorkspaceError> {
    if !metadata.is_file() {
        return Err(WorkspaceError::new(
            WorkspaceErrorCode::FileNotFound,
            operation,
            "The requested Markdown file does not exist.",
            true,
        )
        .with_relative_path(relative_path));
    }

    let modified_at = metadata
        .modified()
        .map(system_time_to_iso)
        .map_err(|error| WorkspaceError::from_io(operation, Some(relative_path), &error))?;
    let byte_size = metadata.len();
    let content_hash = hash_file(path, relative_path, operation)?;
    let token = format!(
        "{modified_at}:{byte_size}:{hash}",
        hash = &content_hash[..16]
    );

    Ok(FileVersion {
        modified_at,
        byte_size,
        content_hash,
        token,
    })
}

fn hash_file(
    path: &Path,
    relative_path: &str,
    operation: WorkspaceOperation,
) -> Result<String, WorkspaceError> {
    let mut file = File::open(path)
        .map_err(|error| WorkspaceError::from_io(operation, Some(relative_path), &error))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0; 8192];

    loop {
        let bytes_read = file
            .read(&mut buffer)
            .map_err(|error| WorkspaceError::from_io(operation, Some(relative_path), &error))?;
        if bytes_read == 0 {
            break;
        }
        hasher.update(&buffer[..bytes_read]);
    }

    Ok(format!("{:x}", hasher.finalize()))
}

fn write_error(
    operation: WorkspaceOperation,
    relative_path: &str,
    error: &io::Error,
) -> WorkspaceError {
    if is_disk_full(error) {
        return WorkspaceError::new(
            WorkspaceErrorCode::DiskFull,
            operation,
            "The filesystem is full or quota was exceeded.",
            true,
        )
        .with_relative_path(relative_path)
        .with_detail("source", error.to_string());
    }

    if error.kind() == io::ErrorKind::PermissionDenied {
        return WorkspaceError::new(
            WorkspaceErrorCode::PermissionDenied,
            operation,
            "The operating system denied access to the requested path.",
            true,
        )
        .with_relative_path(relative_path)
        .with_detail("source", error.to_string());
    }

    WorkspaceError::new(
        WorkspaceErrorCode::WriteFailed,
        operation,
        "The Markdown file could not be written.",
        true,
    )
    .with_relative_path(relative_path)
    .with_detail("source", error.to_string())
}

fn rename_error(relative_path: &str, error: &io::Error) -> WorkspaceError {
    if error.kind() == io::ErrorKind::PermissionDenied {
        return WorkspaceError::new(
            WorkspaceErrorCode::PermissionDenied,
            WorkspaceOperation::RenameFile,
            "The operating system denied access to the requested path.",
            true,
        )
        .with_relative_path(relative_path)
        .with_detail("source", error.to_string());
    }

    WorkspaceError::new(
        WorkspaceErrorCode::RenameFailed,
        WorkspaceOperation::RenameFile,
        "The Markdown file could not be renamed.",
        true,
    )
    .with_relative_path(relative_path)
    .with_detail("source", error.to_string())
}

fn delete_error(relative_path: &str, error: &io::Error) -> WorkspaceError {
    match error.kind() {
        io::ErrorKind::NotFound => WorkspaceError::new(
            WorkspaceErrorCode::FileNotFound,
            WorkspaceOperation::DeleteFile,
            "The requested file does not exist.",
            true,
        ),
        io::ErrorKind::PermissionDenied => WorkspaceError::new(
            WorkspaceErrorCode::PermissionDenied,
            WorkspaceOperation::DeleteFile,
            "The operating system denied access to the requested path.",
            true,
        ),
        _ => WorkspaceError::new(
            WorkspaceErrorCode::DeleteFailed,
            WorkspaceOperation::DeleteFile,
            "The Markdown file could not be deleted.",
            true,
        ),
    }
    .with_relative_path(relative_path)
    .with_detail("source", error.to_string())
}

fn is_disk_full(error: &io::Error) -> bool {
    matches!(error.raw_os_error(), Some(28 | 112 | 122))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::SaveReason;
    use crate::workspace::validate_workspace_root;

    fn record(root: &Path) -> WorkspaceRecord {
        validate_workspace_root(root, WorkspaceOperation::SelectWorkspace).unwrap()
    }

    fn save_request(
        snapshot: &DocumentSnapshot,
        content: &str,
        expected_version: FileVersion,
    ) -> SaveRequest {
        SaveRequest {
            workspace_id: snapshot.workspace_id.clone(),
            relative_path: snapshot.relative_path.clone(),
            content: content.to_owned(),
            expected_version,
            reason: SaveReason::Manual,
        }
    }

    #[test]
    fn creates_and_opens_raw_markdown_document() {
        let temp = tempfile::tempdir().unwrap();
        let record = record(temp.path());

        let created =
            create_document(&record, "notes.md", Some("# Title\n\nRaw text".to_owned())).unwrap();
        let opened = open_document(&record, "notes.md").unwrap();

        assert_eq!(created.content, "# Title\n\nRaw text");
        assert_eq!(opened.content, "# Title\n\nRaw text");
        assert_eq!(opened.version.content_hash.len(), 64);
    }

    #[test]
    fn create_rejects_existing_file_without_overwriting() {
        let temp = tempfile::tempdir().unwrap();
        let record = record(temp.path());
        fs::write(temp.path().join("notes.md"), "existing").unwrap();

        let error = create_document(&record, "notes.md", Some("new".to_owned())).unwrap_err();

        assert_eq!(error.code, WorkspaceErrorCode::FileAlreadyExists);
        assert_eq!(
            fs::read_to_string(temp.path().join("notes.md")).unwrap(),
            "existing"
        );
    }

    #[test]
    fn open_rejects_invalid_utf8() {
        let temp = tempfile::tempdir().unwrap();
        let record = record(temp.path());
        fs::write(temp.path().join("bad.md"), [0xff, 0xfe]).unwrap();

        let error = open_document(&record, "bad.md").unwrap_err();

        assert_eq!(error.code, WorkspaceErrorCode::InvalidUtf8);
    }

    #[test]
    fn saves_when_expected_version_matches() {
        let temp = tempfile::tempdir().unwrap();
        let record = record(temp.path());
        let snapshot = create_document(&record, "notes.md", Some("old".to_owned())).unwrap();

        let result = save_document(
            &record,
            save_request(&snapshot, "new", snapshot.version.clone()),
        )
        .unwrap();

        assert_eq!(result.byte_size, 3);
        assert_eq!(
            fs::read_to_string(temp.path().join("notes.md")).unwrap(),
            "new"
        );
        assert_ne!(result.version.content_hash, snapshot.version.content_hash);
    }

    #[test]
    fn save_detects_external_edit_and_preserves_disk_content() {
        let temp = tempfile::tempdir().unwrap();
        let record = record(temp.path());
        let snapshot = create_document(&record, "notes.md", Some("old".to_owned())).unwrap();
        fs::write(temp.path().join("notes.md"), "external").unwrap();

        let error = save_document(
            &record,
            save_request(&snapshot, "local", snapshot.version.clone()),
        )
        .unwrap_err();

        assert_eq!(error.code, WorkspaceErrorCode::VersionConflict);
        assert_eq!(
            fs::read_to_string(temp.path().join("notes.md")).unwrap(),
            "external"
        );
    }

    #[test]
    fn save_reports_missing_file() {
        let temp = tempfile::tempdir().unwrap();
        let record = record(temp.path());
        let snapshot = create_document(&record, "notes.md", Some("old".to_owned())).unwrap();
        fs::remove_file(temp.path().join("notes.md")).unwrap();

        let error = save_document(
            &record,
            save_request(&snapshot, "new", snapshot.version.clone()),
        )
        .unwrap_err();

        assert_eq!(error.code, WorkspaceErrorCode::FileNotFound);
    }

    #[test]
    fn rename_moves_file_and_returns_updated_index() {
        let temp = tempfile::tempdir().unwrap();
        let record = record(temp.path());
        let snapshot = create_document(&record, "old.md", Some("content".to_owned())).unwrap();

        let result =
            rename_document(&record, "old.md", "new.markdown", Some(snapshot.version)).unwrap();

        assert!(!temp.path().join("old.md").exists());
        assert_eq!(
            fs::read_to_string(temp.path().join("new.markdown")).unwrap(),
            "content"
        );
        assert_eq!(result.new_relative_path, "new.markdown");
        assert_eq!(result.files.len(), 1);
        assert_eq!(result.files[0].relative_path, "new.markdown");
    }

    #[test]
    fn rename_rejects_destination_collision() {
        let temp = tempfile::tempdir().unwrap();
        let record = record(temp.path());
        create_document(&record, "old.md", Some("old".to_owned())).unwrap();
        fs::write(temp.path().join("new.md"), "existing").unwrap();

        let error = rename_document(&record, "old.md", "new.md", None).unwrap_err();

        assert_eq!(error.code, WorkspaceErrorCode::FileAlreadyExists);
        assert_eq!(
            fs::read_to_string(temp.path().join("new.md")).unwrap(),
            "existing"
        );
    }

    #[test]
    fn rename_detects_external_edit_when_version_is_supplied() {
        let temp = tempfile::tempdir().unwrap();
        let record = record(temp.path());
        let snapshot = create_document(&record, "old.md", Some("old".to_owned())).unwrap();
        fs::write(temp.path().join("old.md"), "external").unwrap();

        let error =
            rename_document(&record, "old.md", "new.md", Some(snapshot.version)).unwrap_err();

        assert_eq!(error.code, WorkspaceErrorCode::VersionConflict);
        assert!(temp.path().join("old.md").exists());
        assert!(!temp.path().join("new.md").exists());
    }

    #[test]
    fn delete_removes_file_and_returns_updated_index() {
        let temp = tempfile::tempdir().unwrap();
        let record = record(temp.path());
        let snapshot = create_document(&record, "notes.md", Some("content".to_owned())).unwrap();
        create_document(&record, "other.md", Some("other".to_owned())).unwrap();

        let result = delete_document(&record, "notes.md", Some(snapshot.version)).unwrap();

        assert!(!temp.path().join("notes.md").exists());
        assert_eq!(result.files.len(), 1);
        assert_eq!(result.files[0].relative_path, "other.md");
    }

    #[test]
    fn delete_detects_external_edit_when_version_is_supplied() {
        let temp = tempfile::tempdir().unwrap();
        let record = record(temp.path());
        let snapshot = create_document(&record, "notes.md", Some("old".to_owned())).unwrap();
        fs::write(temp.path().join("notes.md"), "external").unwrap();

        let error = delete_document(&record, "notes.md", Some(snapshot.version)).unwrap_err();

        assert_eq!(error.code, WorkspaceErrorCode::VersionConflict);
        assert!(temp.path().join("notes.md").exists());
    }

    #[test]
    fn rejects_path_escape_before_writing() {
        let temp = tempfile::tempdir().unwrap();
        let record = record(temp.path());

        let error = create_document(&record, "../outside.md", Some("bad".to_owned())).unwrap_err();

        assert_eq!(error.code, WorkspaceErrorCode::InvalidRelativePath);
        assert!(!temp.path().parent().unwrap().join("outside.md").exists());
    }

    #[test]
    fn supports_empty_files() {
        let temp = tempfile::tempdir().unwrap();
        let record = record(temp.path());

        let snapshot = create_document(&record, "empty.md", None).unwrap();
        let opened = open_document(&record, "empty.md").unwrap();

        assert_eq!(snapshot.content, "");
        assert_eq!(opened.content, "");
        assert_eq!(opened.version.byte_size, 0);
    }
}
