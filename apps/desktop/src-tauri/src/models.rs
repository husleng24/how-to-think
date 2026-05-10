use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub type WorkspaceId = String;
pub type WorkspaceRelativePath = String;
pub type IsoDateTime = String;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum Platform {
    #[serde(rename = "windows")]
    Windows,
    #[serde(rename = "macos")]
    Macos,
    #[serde(rename = "linux")]
    Linux,
}

impl Platform {
    pub fn current() -> Self {
        if cfg!(target_os = "windows") {
            Self::Windows
        } else if cfg!(target_os = "macos") {
            Self::Macos
        } else {
            Self::Linux
        }
    }

    pub fn default_case_sensitive(self) -> bool {
        matches!(self, Self::Linux)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
    pub id: WorkspaceId,
    pub display_name: String,
    pub display_path: String,
    pub platform: Platform,
    pub case_sensitive: bool,
    pub writable: bool,
    pub last_opened_at: IsoDateTime,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileVersion {
    pub modified_at: IsoDateTime,
    pub byte_size: u64,
    pub content_hash: String,
    pub token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFile {
    pub relative_path: WorkspaceRelativePath,
    pub name: String,
    pub extension: String,
    pub byte_size: u64,
    pub modified_at: IsoDateTime,
    pub version: FileVersion,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSession {
    pub workspace: WorkspaceInfo,
    pub files: Vec<WorkspaceFile>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_opened_file: Option<WorkspaceRelativePath>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceRecord {
    pub info: WorkspaceInfo,
    pub canonical_root: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DocumentSnapshot {
    pub workspace_id: WorkspaceId,
    pub relative_path: WorkspaceRelativePath,
    pub content: String,
    pub version: FileVersion,
    pub opened_at: IsoDateTime,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SaveReason {
    Manual,
    Autosave,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SaveRequest {
    pub workspace_id: WorkspaceId,
    pub relative_path: WorkspaceRelativePath,
    pub content: String,
    pub expected_version: FileVersion,
    pub reason: SaveReason,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SaveResult {
    pub workspace_id: WorkspaceId,
    pub relative_path: WorkspaceRelativePath,
    pub version: FileVersion,
    pub saved_at: IsoDateTime,
    pub byte_size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RenameDocumentResult {
    pub workspace_id: WorkspaceId,
    pub relative_path: WorkspaceRelativePath,
    pub new_relative_path: WorkspaceRelativePath,
    pub file: WorkspaceFile,
    pub files: Vec<WorkspaceFile>,
    pub renamed_at: IsoDateTime,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeleteDocumentResult {
    pub workspace_id: WorkspaceId,
    pub relative_path: WorkspaceRelativePath,
    pub files: Vec<WorkspaceFile>,
    pub deleted_at: IsoDateTime,
}
