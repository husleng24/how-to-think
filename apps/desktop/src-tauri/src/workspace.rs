use crate::errors::{WorkspaceError, WorkspaceErrorCode, WorkspaceOperation};
use crate::file_index::index_markdown_files;
use crate::models::{
    Platform, WorkspaceInfo, WorkspaceRecord, WorkspaceRelativePath, WorkspaceSession,
};
use crate::time_utils::now_iso;
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io;
use std::path::Path;

pub fn create_workspace(path: impl AsRef<Path>) -> Result<WorkspaceRecord, WorkspaceError> {
    if path.as_ref().exists() && !path.as_ref().is_dir() {
        return Err(WorkspaceError::new(
            WorkspaceErrorCode::WorkspaceNotDirectory,
            WorkspaceOperation::CreateWorkspace,
            "The workspace path is not a directory.",
            true,
        ));
    }

    fs::create_dir_all(path.as_ref()).map_err(|error| {
        workspace_path_error(WorkspaceOperation::CreateWorkspace, &error)
            .with_detail("path", path.as_ref().display().to_string())
    })?;
    validate_workspace_root(path, WorkspaceOperation::CreateWorkspace)
}

pub fn validate_workspace_root(
    path: impl AsRef<Path>,
    operation: WorkspaceOperation,
) -> Result<WorkspaceRecord, WorkspaceError> {
    let canonical_root =
        fs::canonicalize(path.as_ref()).map_err(|error| workspace_path_error(operation, &error))?;
    let metadata =
        fs::metadata(&canonical_root).map_err(|error| workspace_path_error(operation, &error))?;

    if !metadata.is_dir() {
        return Err(WorkspaceError::new(
            WorkspaceErrorCode::WorkspaceNotDirectory,
            operation,
            "The workspace path is not a directory.",
            true,
        ));
    }

    fs::read_dir(&canonical_root).map_err(|error| workspace_path_error(operation, &error))?;

    let platform = Platform::current();
    let case_sensitive = platform.default_case_sensitive();
    let display_path = canonical_root.display().to_string();
    let display_name = canonical_root
        .file_name()
        .and_then(|name| name.to_str())
        .map(str::to_owned)
        .unwrap_or_else(|| display_path.clone());
    let info = WorkspaceInfo {
        id: workspace_id(&canonical_root, case_sensitive),
        display_name,
        display_path,
        platform,
        case_sensitive,
        writable: is_writable_directory(&canonical_root),
        last_opened_at: now_iso(),
    };

    Ok(WorkspaceRecord {
        info,
        canonical_root,
    })
}

pub fn workspace_session(record: &WorkspaceRecord) -> Result<WorkspaceSession, WorkspaceError> {
    workspace_session_with_last_opened_file(record, None)
}

pub fn workspace_session_with_last_opened_file(
    record: &WorkspaceRecord,
    last_opened_file: Option<WorkspaceRelativePath>,
) -> Result<WorkspaceSession, WorkspaceError> {
    let files = index_markdown_files(&record.canonical_root, record.info.case_sensitive)?;
    let last_opened_file = last_opened_file.filter(|relative_path| {
        files
            .iter()
            .any(|file| file.relative_path.as_str() == relative_path.as_str())
    });

    Ok(WorkspaceSession {
        workspace: record.info.clone(),
        files,
        last_opened_file,
    })
}

pub fn load_workspace_session(
    path: impl AsRef<Path>,
    operation: WorkspaceOperation,
) -> Result<(WorkspaceRecord, WorkspaceSession), WorkspaceError> {
    let record = validate_workspace_root(path, operation)?;
    let session = workspace_session(&record)?;
    Ok((record, session))
}

fn workspace_id(canonical_root: &Path, case_sensitive: bool) -> String {
    let mut root = canonical_root.to_string_lossy().replace('\\', "/");
    if !case_sensitive {
        root = root.to_ascii_lowercase();
    }

    let digest = Sha256::digest(root.as_bytes());
    format!("{:x}", digest)
}

fn is_writable_directory(root: &Path) -> bool {
    let probe_path = root.join(format!(
        ".how-to-think-write-test-{}-{}",
        std::process::id(),
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
    ));

    match OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe_path)
    {
        Ok(file) => {
            drop(file);
            let _ = fs::remove_file(probe_path);
            true
        }
        Err(_) => false,
    }
}

fn workspace_path_error(operation: WorkspaceOperation, error: &io::Error) -> WorkspaceError {
    let (code, message) = match error.kind() {
        io::ErrorKind::NotFound => (
            WorkspaceErrorCode::WorkspaceMissing,
            "The workspace directory does not exist.",
        ),
        io::ErrorKind::PermissionDenied => (
            WorkspaceErrorCode::PermissionDenied,
            "The operating system denied access to the workspace.",
        ),
        _ => (
            WorkspaceErrorCode::InvalidWorkspacePath,
            "The workspace path cannot be used.",
        ),
    };

    WorkspaceError::new(code, operation, message, true).with_detail("source", error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_existing_workspace_directory() {
        let temp = tempfile::tempdir().unwrap();
        let record = validate_workspace_root(temp.path(), WorkspaceOperation::SelectWorkspace)
            .expect("workspace should validate");

        assert_eq!(
            record.info.display_name,
            temp.path()
                .file_name()
                .unwrap()
                .to_string_lossy()
                .to_string()
        );
        assert!(record.info.writable);
        assert_eq!(record.info.id.len(), 64);
    }

    #[test]
    fn rejects_workspace_path_that_is_not_a_directory() {
        let temp = tempfile::tempdir().unwrap();
        let file_path = temp.path().join("not-a-workspace");
        fs::write(&file_path, "content").unwrap();

        let error =
            validate_workspace_root(&file_path, WorkspaceOperation::SelectWorkspace).unwrap_err();
        assert_eq!(error.code, WorkspaceErrorCode::WorkspaceNotDirectory);
    }

    #[test]
    fn creates_workspace_directories() {
        let temp = tempfile::tempdir().unwrap();
        let workspace_path = temp.path().join("nested/workspace");

        let record = create_workspace(&workspace_path).unwrap();

        assert!(workspace_path.is_dir());
        assert_eq!(
            record.canonical_root,
            fs::canonicalize(workspace_path).unwrap()
        );
    }

    #[test]
    fn loads_workspace_session_with_index() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("idea.md"), "# Idea").unwrap();

        let (_, session) =
            load_workspace_session(temp.path(), WorkspaceOperation::SelectWorkspace).unwrap();

        assert_eq!(session.files.len(), 1);
        assert_eq!(session.files[0].relative_path, "idea.md");
        assert_eq!(session.last_opened_file, None);
    }
}
