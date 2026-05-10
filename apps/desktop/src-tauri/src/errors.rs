use crate::models::WorkspaceRelativePath;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fmt;
use std::io;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceErrorCode {
    WorkspaceNotSelected,
    WorkspaceMissing,
    WorkspaceNotDirectory,
    WorkspaceUnwritable,
    PermissionDenied,
    InvalidWorkspacePath,
    InvalidRelativePath,
    PathOutsideWorkspace,
    InvalidAiContextRequest,
    UnsupportedFileType,
    FileNotFound,
    FileAlreadyExists,
    InvalidUtf8,
    VersionConflict,
    WriteFailed,
    DiskFull,
    RenameFailed,
    DeleteFailed,
    WatchUnavailable,
    OperationCancelled,
    UnknownIoError,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum WorkspaceOperation {
    SelectWorkspace,
    CreateWorkspace,
    LoadWorkspace,
    ListFiles,
    CreateFile,
    OpenFile,
    SaveFile,
    RenameFile,
    DeleteFile,
    WatchWorkspace,
    BuildAiContext,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceError {
    pub code: WorkspaceErrorCode,
    pub message: String,
    pub recoverable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub relative_path: Option<WorkspaceRelativePath>,
    pub operation: WorkspaceOperation,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<BTreeMap<String, Value>>,
}

impl WorkspaceError {
    pub fn new(
        code: WorkspaceErrorCode,
        operation: WorkspaceOperation,
        message: impl Into<String>,
        recoverable: bool,
    ) -> Self {
        Self {
            code,
            message: message.into(),
            recoverable,
            relative_path: None,
            operation,
            details: None,
        }
    }

    pub fn with_relative_path(mut self, relative_path: impl Into<String>) -> Self {
        self.relative_path = Some(relative_path.into());
        self
    }

    pub fn with_detail(mut self, key: impl Into<String>, value: impl Serialize) -> Self {
        if let Ok(value) = serde_json::to_value(value) {
            self.details
                .get_or_insert_with(BTreeMap::new)
                .insert(key.into(), value);
        }

        self
    }

    pub fn from_io(
        operation: WorkspaceOperation,
        relative_path: Option<&str>,
        error: &io::Error,
    ) -> Self {
        let (code, message) = if is_disk_full(error) {
            (
                WorkspaceErrorCode::DiskFull,
                "The filesystem is full or quota was exceeded.",
            )
        } else {
            match error.kind() {
                io::ErrorKind::NotFound => (
                    WorkspaceErrorCode::FileNotFound,
                    "The requested file does not exist.",
                ),
                io::ErrorKind::PermissionDenied => (
                    WorkspaceErrorCode::PermissionDenied,
                    "The operating system denied access to the requested path.",
                ),
                _ => (
                    WorkspaceErrorCode::UnknownIoError,
                    "The filesystem operation failed unexpectedly.",
                ),
            }
        };

        let mut workspace_error =
            Self::new(code, operation, message, true).with_detail("source", error.to_string());

        if let Some(relative_path) = relative_path {
            workspace_error = workspace_error.with_relative_path(relative_path);
        }

        workspace_error
    }
}

impl fmt::Display for WorkspaceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{:?}: {}", self.code, self.message)
    }
}

impl std::error::Error for WorkspaceError {}

fn is_disk_full(error: &io::Error) -> bool {
    matches!(error.raw_os_error(), Some(28 | 112 | 122))
}
