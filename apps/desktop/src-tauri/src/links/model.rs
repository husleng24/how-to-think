use crate::models::{WorkspaceId, WorkspaceRelativePath};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum LinkKind {
    StandardMarkdown,
    ObsidianWiki,
    Image,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LinkReference {
    pub kind: LinkKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub target: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alias: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResolveLinkRequest {
    pub workspace_id: WorkspaceId,
    pub source_relative_path: WorkspaceRelativePath,
    pub link: LinkReference,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResolveLinksRequest {
    pub workspace_id: WorkspaceId,
    pub source_relative_path: WorkspaceRelativePath,
    pub links: Vec<LinkReference>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResolveLinksResponse {
    pub workspace_id: WorkspaceId,
    pub source_relative_path: WorkspaceRelativePath,
    pub links: Vec<LinkResolution>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LinkResolutionStatus {
    Resolved,
    Unresolved,
    Ambiguous,
    Rejected,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum LinkDiagnosticSeverity {
    Info,
    Warning,
    Error,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum LinkDiagnosticCode {
    DuplicateFilenameStem,
    AmbiguousTarget,
    MissingTarget,
    CaseMismatch,
    WorkspaceEscape,
    UnsupportedProtocol,
    UnsupportedTarget,
    InvalidPath,
    MissingHeading,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LinkDiagnostic {
    pub code: LinkDiagnosticCode,
    pub severity: LinkDiagnosticSeverity,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_relative_path: Option<WorkspaceRelativePath>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub candidates: Vec<LinkCandidate>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub struct LinkCandidate {
    pub relative_path: WorkspaceRelativePath,
    pub name: String,
    pub stem: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub heading: Option<HeadingAnchor>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub struct HeadingAnchor {
    pub text: String,
    pub anchor: String,
    pub line: usize,
    pub level: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LinkOpenIntent {
    pub workspace_id: WorkspaceId,
    pub relative_path: WorkspaceRelativePath,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fragment: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LinkCreateIntent {
    pub workspace_id: WorkspaceId,
    pub relative_path: WorkspaceRelativePath,
    pub title: String,
    pub normalized_filename: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LinkResolution {
    pub workspace_id: WorkspaceId,
    pub source_relative_path: WorkspaceRelativePath,
    pub kind: LinkKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw: Option<String>,
    pub target: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alias: Option<String>,
    pub display_text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fragment: Option<String>,
    pub status: LinkResolutionStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub open: Option<LinkOpenIntent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub create: Option<LinkCreateIntent>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub candidates: Vec<LinkCandidate>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub diagnostics: Vec<LinkDiagnostic>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LinkIndexFile {
    pub relative_path: WorkspaceRelativePath,
    pub absolute_path: String,
    pub name: String,
    pub stem: String,
    pub path_lookup_key: String,
    pub stem_lookup_key: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub headings: Vec<HeadingAnchor>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LinkIndexSnapshot {
    pub workspace_id: WorkspaceId,
    pub files: Vec<LinkIndexFile>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub diagnostics: Vec<LinkDiagnostic>,
}
