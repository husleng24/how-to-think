use crate::models::{FileVersion, IsoDateTime, WorkspaceId, WorkspaceRelativePath};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GitOperationErrorCode {
    GitUnavailable,
    NotRepository,
    RepositoryCorrupt,
    ParentRepository,
    NestedRepository,
    BareRepository,
    DetachedHead,
    MergeConflict,
    PermissionDenied,
    IdentityMissing,
    NoChanges,
    InvalidRef,
    FileNotInHistory,
    ExternalStateChanged,
    RestoreConflict,
    UnknownGitError,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GitRepositoryStateKind {
    GitUnavailable,
    NotRepository,
    ValidRepository,
    RepositoryCorrupt,
    ParentRepository,
    NestedRepository,
    BareRepository,
    DetachedHead,
    MergeConflict,
    PermissionDenied,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum GitServiceOperation {
    Detect,
    Init,
    Status,
    Snapshot,
    History,
    Diff,
    Restore,
    Refresh,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GitServiceMutability {
    ReadOnly,
    Mutating,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GitOperationAccess {
    Allowed,
    ReadOnly,
    Blocked,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GitBackendKind {
    SystemGit,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GitStatusChangeKind {
    Unmodified,
    Added,
    Modified,
    Deleted,
    Renamed,
    Copied,
    Untracked,
    Ignored,
    Unmerged,
    Unknown,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GitDiffMode {
    WorkingTree,
    Staged,
    RefRange,
}

pub const GIT_OPERATION_ERROR_CODES: &[GitOperationErrorCode] = &[
    GitOperationErrorCode::GitUnavailable,
    GitOperationErrorCode::NotRepository,
    GitOperationErrorCode::RepositoryCorrupt,
    GitOperationErrorCode::ParentRepository,
    GitOperationErrorCode::NestedRepository,
    GitOperationErrorCode::BareRepository,
    GitOperationErrorCode::DetachedHead,
    GitOperationErrorCode::MergeConflict,
    GitOperationErrorCode::PermissionDenied,
    GitOperationErrorCode::IdentityMissing,
    GitOperationErrorCode::NoChanges,
    GitOperationErrorCode::InvalidRef,
    GitOperationErrorCode::FileNotInHistory,
    GitOperationErrorCode::ExternalStateChanged,
    GitOperationErrorCode::RestoreConflict,
    GitOperationErrorCode::UnknownGitError,
];

pub const GIT_REPOSITORY_STATE_KINDS: &[GitRepositoryStateKind] = &[
    GitRepositoryStateKind::GitUnavailable,
    GitRepositoryStateKind::NotRepository,
    GitRepositoryStateKind::ValidRepository,
    GitRepositoryStateKind::RepositoryCorrupt,
    GitRepositoryStateKind::ParentRepository,
    GitRepositoryStateKind::NestedRepository,
    GitRepositoryStateKind::BareRepository,
    GitRepositoryStateKind::DetachedHead,
    GitRepositoryStateKind::MergeConflict,
    GitRepositoryStateKind::PermissionDenied,
];

pub const GIT_SERVICE_OPERATIONS: &[GitServiceOperation] = &[
    GitServiceOperation::Detect,
    GitServiceOperation::Init,
    GitServiceOperation::Status,
    GitServiceOperation::Snapshot,
    GitServiceOperation::History,
    GitServiceOperation::Diff,
    GitServiceOperation::Restore,
    GitServiceOperation::Refresh,
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitBackendInfo {
    pub kind: GitBackendKind,
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub executable_display_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitRepositoryStateToken {
    pub token: String,
    pub head_oid: Option<String>,
    pub index_version: Option<u64>,
    pub index_checksum: Option<String>,
    pub worktree_status_generation: String,
    pub captured_at: IsoDateTime,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitRepositoryWarning {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitRepositoryState {
    pub workspace_id: WorkspaceId,
    pub state: GitRepositoryStateKind,
    pub backend: GitBackendInfo,
    pub selected_root_display_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repository_root_display_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub relative_prefix: Option<WorkspaceRelativePath>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub head_oid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<GitRepositoryStateToken>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocked_reason: Option<GitOperationErrorCode>,
    pub warnings: Vec<GitRepositoryWarning>,
    pub checked_at: IsoDateTime,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusEntry {
    pub relative_path: WorkspaceRelativePath,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous_relative_path: Option<WorkspaceRelativePath>,
    pub staged: GitStatusChangeKind,
    pub unstaged: GitStatusChangeKind,
    pub conflicted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusSummary {
    pub workspace_id: WorkspaceId,
    pub repository_state: GitRepositoryState,
    pub token: Option<GitRepositoryStateToken>,
    pub entries: Vec<GitStatusEntry>,
    pub has_changes: bool,
    pub has_conflicts: bool,
    pub changed_file_count: usize,
    pub untracked_file_count: usize,
    pub refreshed_at: IsoDateTime,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitExpectedFileState {
    pub relative_path: WorkspaceRelativePath,
    pub expected_version: FileVersion,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitAuthorIdentity {
    pub name: String,
    pub email: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitSnapshotRequest {
    pub workspace_id: WorkspaceId,
    pub message: String,
    pub scope_paths: Vec<WorkspaceRelativePath>,
    pub expected_repo_token: GitRepositoryStateToken,
    pub expected_file_states: Vec<GitExpectedFileState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<GitAuthorIdentity>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitSnapshotResult {
    pub workspace_id: WorkspaceId,
    pub commit_oid: String,
    pub parent_oids: Vec<String>,
    pub message: String,
    pub repository_state: GitRepositoryState,
    pub status: GitStatusSummary,
    pub snapshot_at: IsoDateTime,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitHistoryRequest {
    pub workspace_id: WorkspaceId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub relative_path: Option<WorkspaceRelativePath>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_entries: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitHistoryEntry {
    pub commit_oid: String,
    pub parent_oids: Vec<String>,
    pub author_name: String,
    pub author_email: String,
    pub authored_at: IsoDateTime,
    pub subject: String,
    pub touched_paths: Vec<WorkspaceRelativePath>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffRequest {
    pub workspace_id: WorkspaceId,
    pub mode: GitDiffMode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub relative_path: Option<WorkspaceRelativePath>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub head_ref: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffResult {
    pub workspace_id: WorkspaceId,
    pub mode: GitDiffMode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub relative_path: Option<WorkspaceRelativePath>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub head_ref: Option<String>,
    pub patch: String,
    pub is_binary: bool,
    pub changed_line_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitRestoreRequest {
    pub workspace_id: WorkspaceId,
    pub relative_path: WorkspaceRelativePath,
    pub source_ref: String,
    pub expected_repo_token: GitRepositoryStateToken,
    pub expected_file_version: FileVersion,
    #[serde(default, skip_serializing_if = "is_false")]
    pub dry_run: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitRestoreResult {
    pub workspace_id: WorkspaceId,
    pub relative_path: WorkspaceRelativePath,
    pub restored_from: String,
    pub file_version: FileVersion,
    pub repository_state: GitRepositoryState,
    pub status: GitStatusSummary,
    pub restored_at: IsoDateTime,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitOperationError {
    pub code: GitOperationErrorCode,
    pub operation: GitServiceOperation,
    pub message: String,
    pub recoverable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub relative_path: Option<WorkspaceRelativePath>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<BTreeMap<String, Value>>,
}

impl GitOperationError {
    pub fn new(
        code: GitOperationErrorCode,
        operation: GitServiceOperation,
        message: impl Into<String>,
        recoverable: bool,
    ) -> Self {
        Self {
            code,
            operation,
            message: message.into(),
            recoverable,
            relative_path: None,
            details: None,
        }
    }

    pub fn with_relative_path(mut self, relative_path: impl Into<String>) -> Self {
        self.relative_path = Some(relative_path.into());
        self
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitServiceMethodSignature {
    pub operation: GitServiceOperation,
    pub command_name: &'static str,
    pub request_type: &'static str,
    pub result_type: &'static str,
    pub mutability: GitServiceMutability,
    pub requires_workspace: bool,
    pub requires_expected_repo_token: bool,
    pub requires_expected_file_version: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitOperationPermissionPolicy {
    pub operation: GitServiceOperation,
    pub access: GitOperationAccess,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocked_by: Option<GitOperationErrorCode>,
}

pub const GIT_SERVICE_METHODS: &[GitServiceMethodSignature] = &[
    GitServiceMethodSignature {
        operation: GitServiceOperation::Detect,
        command_name: "git_detect_repository",
        request_type: "{ workspaceId }",
        result_type: "GitRepositoryState",
        mutability: GitServiceMutability::ReadOnly,
        requires_workspace: true,
        requires_expected_repo_token: false,
        requires_expected_file_version: false,
    },
    GitServiceMethodSignature {
        operation: GitServiceOperation::Init,
        command_name: "git_init_repository",
        request_type: "{ workspaceId }",
        result_type: "GitRepositoryState",
        mutability: GitServiceMutability::Mutating,
        requires_workspace: true,
        requires_expected_repo_token: false,
        requires_expected_file_version: false,
    },
    GitServiceMethodSignature {
        operation: GitServiceOperation::Status,
        command_name: "git_status",
        request_type: "{ workspaceId }",
        result_type: "GitStatusSummary",
        mutability: GitServiceMutability::ReadOnly,
        requires_workspace: true,
        requires_expected_repo_token: false,
        requires_expected_file_version: false,
    },
    GitServiceMethodSignature {
        operation: GitServiceOperation::Snapshot,
        command_name: "git_create_snapshot",
        request_type: "GitSnapshotRequest",
        result_type: "GitSnapshotResult",
        mutability: GitServiceMutability::Mutating,
        requires_workspace: true,
        requires_expected_repo_token: true,
        requires_expected_file_version: true,
    },
    GitServiceMethodSignature {
        operation: GitServiceOperation::History,
        command_name: "git_history",
        request_type: "GitHistoryRequest",
        result_type: "GitHistoryEntry[]",
        mutability: GitServiceMutability::ReadOnly,
        requires_workspace: true,
        requires_expected_repo_token: false,
        requires_expected_file_version: false,
    },
    GitServiceMethodSignature {
        operation: GitServiceOperation::Diff,
        command_name: "git_diff",
        request_type: "GitDiffRequest",
        result_type: "GitDiffResult",
        mutability: GitServiceMutability::ReadOnly,
        requires_workspace: true,
        requires_expected_repo_token: false,
        requires_expected_file_version: false,
    },
    GitServiceMethodSignature {
        operation: GitServiceOperation::Restore,
        command_name: "git_restore_file",
        request_type: "GitRestoreRequest",
        result_type: "GitRestoreResult",
        mutability: GitServiceMutability::Mutating,
        requires_workspace: true,
        requires_expected_repo_token: true,
        requires_expected_file_version: true,
    },
    GitServiceMethodSignature {
        operation: GitServiceOperation::Refresh,
        command_name: "git_refresh",
        request_type: "{ workspaceId }",
        result_type: "GitRepositoryState",
        mutability: GitServiceMutability::ReadOnly,
        requires_workspace: true,
        requires_expected_repo_token: false,
        requires_expected_file_version: false,
    },
];

pub fn git_operation_policy(
    state: GitRepositoryStateKind,
    operation: GitServiceOperation,
) -> GitOperationPermissionPolicy {
    if matches!(
        operation,
        GitServiceOperation::Detect | GitServiceOperation::Refresh
    ) {
        return policy(operation, GitOperationAccess::ReadOnly, None);
    }

    match operation {
        GitServiceOperation::Init => {
            if state == GitRepositoryStateKind::NotRepository {
                policy(operation, GitOperationAccess::Allowed, None)
            } else {
                policy(
                    operation,
                    GitOperationAccess::Blocked,
                    Some(init_blocked_by(state)),
                )
            }
        }
        GitServiceOperation::Status => {
            if matches!(
                state,
                GitRepositoryStateKind::ValidRepository
                    | GitRepositoryStateKind::NestedRepository
                    | GitRepositoryStateKind::NotRepository
                    | GitRepositoryStateKind::ParentRepository
                    | GitRepositoryStateKind::DetachedHead
                    | GitRepositoryStateKind::MergeConflict
            ) {
                policy(operation, GitOperationAccess::ReadOnly, None)
            } else {
                policy(
                    operation,
                    GitOperationAccess::Blocked,
                    Some(blocked_by_state(state)),
                )
            }
        }
        GitServiceOperation::History | GitServiceOperation::Diff => {
            if matches!(
                state,
                GitRepositoryStateKind::ValidRepository
                    | GitRepositoryStateKind::NestedRepository
                    | GitRepositoryStateKind::ParentRepository
                    | GitRepositoryStateKind::DetachedHead
                    | GitRepositoryStateKind::MergeConflict
            ) {
                policy(operation, GitOperationAccess::ReadOnly, None)
            } else {
                policy(
                    operation,
                    GitOperationAccess::Blocked,
                    Some(blocked_by_state(state)),
                )
            }
        }
        GitServiceOperation::Snapshot | GitServiceOperation::Restore => {
            if matches!(
                state,
                GitRepositoryStateKind::ValidRepository | GitRepositoryStateKind::NestedRepository
            ) {
                policy(operation, GitOperationAccess::Allowed, None)
            } else {
                policy(
                    operation,
                    GitOperationAccess::Blocked,
                    Some(blocked_by_state(state)),
                )
            }
        }
        GitServiceOperation::Detect | GitServiceOperation::Refresh => {
            policy(operation, GitOperationAccess::ReadOnly, None)
        }
    }
}

pub fn is_git_operation_allowed(
    state: GitRepositoryStateKind,
    operation: GitServiceOperation,
) -> bool {
    git_operation_policy(state, operation).access != GitOperationAccess::Blocked
}

pub fn validate_git_workspace_relative_path(
    relative_path: &str,
    operation: GitServiceOperation,
) -> Result<WorkspaceRelativePath, GitOperationError> {
    if relative_path.is_empty() {
        return Err(path_denied(
            operation,
            relative_path,
            "Git paths must be non-empty workspace-relative paths.",
        ));
    }

    if relative_path.starts_with("//") || relative_path.starts_with('/') {
        return Err(path_denied(
            operation,
            relative_path,
            "Git paths must be workspace-relative.",
        ));
    }

    if has_windows_drive_prefix(relative_path) {
        return Err(path_denied(
            operation,
            relative_path,
            "Git paths cannot use a Windows drive prefix.",
        ));
    }

    if relative_path.contains('\\') {
        return Err(path_denied(
            operation,
            relative_path,
            "Git paths must use / separators.",
        ));
    }

    if relative_path.chars().any(char::is_control) {
        return Err(path_denied(
            operation,
            relative_path,
            "Git paths cannot contain control characters.",
        ));
    }

    for segment in relative_path.split('/') {
        if segment.is_empty() || matches!(segment, "." | "..") {
            return Err(path_denied(
                operation,
                relative_path,
                "Git paths cannot contain empty or dot segments.",
            ));
        }

        if segment.eq_ignore_ascii_case(".git") {
            return Err(path_denied(
                operation,
                relative_path,
                "Git metadata internals are not addressable by UI commands.",
            ));
        }
    }

    Ok(relative_path.to_owned())
}

pub fn is_repository_token_stale(
    expected: Option<&GitRepositoryStateToken>,
    current: Option<&GitRepositoryStateToken>,
) -> bool {
    let (Some(expected), Some(current)) = (expected, current) else {
        return true;
    };

    expected.token != current.token
        || expected.head_oid != current.head_oid
        || expected.index_version != current.index_version
        || expected.index_checksum != current.index_checksum
        || expected.worktree_status_generation != current.worktree_status_generation
}

fn init_blocked_by(state: GitRepositoryStateKind) -> GitOperationErrorCode {
    if matches!(
        state,
        GitRepositoryStateKind::ValidRepository | GitRepositoryStateKind::NestedRepository
    ) {
        GitOperationErrorCode::NoChanges
    } else {
        blocked_by_state(state)
    }
}

fn blocked_by_state(state: GitRepositoryStateKind) -> GitOperationErrorCode {
    match state {
        GitRepositoryStateKind::GitUnavailable => GitOperationErrorCode::GitUnavailable,
        GitRepositoryStateKind::NotRepository => GitOperationErrorCode::NotRepository,
        GitRepositoryStateKind::ValidRepository => GitOperationErrorCode::NoChanges,
        GitRepositoryStateKind::RepositoryCorrupt => GitOperationErrorCode::RepositoryCorrupt,
        GitRepositoryStateKind::ParentRepository => GitOperationErrorCode::ParentRepository,
        GitRepositoryStateKind::NestedRepository => GitOperationErrorCode::NestedRepository,
        GitRepositoryStateKind::BareRepository => GitOperationErrorCode::BareRepository,
        GitRepositoryStateKind::DetachedHead => GitOperationErrorCode::DetachedHead,
        GitRepositoryStateKind::MergeConflict => GitOperationErrorCode::MergeConflict,
        GitRepositoryStateKind::PermissionDenied => GitOperationErrorCode::PermissionDenied,
    }
}

fn policy(
    operation: GitServiceOperation,
    access: GitOperationAccess,
    blocked_by: Option<GitOperationErrorCode>,
) -> GitOperationPermissionPolicy {
    GitOperationPermissionPolicy {
        operation,
        access,
        blocked_by,
    }
}

fn path_denied(
    operation: GitServiceOperation,
    relative_path: &str,
    message: &'static str,
) -> GitOperationError {
    GitOperationError::new(
        GitOperationErrorCode::PermissionDenied,
        operation,
        message,
        true,
    )
    .with_relative_path(relative_path)
}

fn has_windows_drive_prefix(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic()
}

fn is_false(value: &bool) -> bool {
    !*value
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample_token() -> GitRepositoryStateToken {
        GitRepositoryStateToken {
            token: "head:abc:index:3:status:clean".to_owned(),
            head_oid: Some("abcdef1234567890".to_owned()),
            index_version: Some(3),
            index_checksum: Some("index-checksum".to_owned()),
            worktree_status_generation: "clean-0001".to_owned(),
            captured_at: "2026-05-11T00:00:00.000Z".to_owned(),
        }
    }

    #[test]
    fn serializes_error_codes_and_fields_with_public_contract_names() {
        let error = GitOperationError::new(
            GitOperationErrorCode::ExternalStateChanged,
            GitServiceOperation::Restore,
            "Repository state changed outside the app.",
            true,
        )
        .with_relative_path("notes/idea.md");

        let serialized = serde_json::to_value(error).unwrap();
        assert_eq!(serialized["code"], json!("external_state_changed"));
        assert_eq!(serialized["operation"], json!("restore"));
        assert_eq!(serialized["relativePath"], json!("notes/idea.md"));
    }

    #[test]
    fn serializes_repository_state_token_with_camel_case_fields() {
        let state = GitRepositoryState {
            workspace_id: "workspace-1".to_owned(),
            state: GitRepositoryStateKind::ValidRepository,
            backend: GitBackendInfo {
                kind: GitBackendKind::SystemGit,
                version: Some("git version 2.52.0.windows.1".to_owned()),
                executable_display_path: None,
            },
            selected_root_display_path: "C:/Users/example/notes".to_owned(),
            repository_root_display_path: Some("C:/Users/example/notes".to_owned()),
            relative_prefix: None,
            branch_name: Some("main".to_owned()),
            head_oid: Some("abcdef1234567890".to_owned()),
            token: Some(sample_token()),
            blocked_reason: None,
            warnings: vec![],
            checked_at: "2026-05-11T00:00:01.000Z".to_owned(),
        };

        let serialized = serde_json::to_value(state).unwrap();
        assert_eq!(serialized["workspaceId"], json!("workspace-1"));
        assert_eq!(serialized["state"], json!("valid_repository"));
        assert_eq!(
            serialized["token"]["worktreeStatusGeneration"],
            json!("clean-0001")
        );
    }

    #[test]
    fn rejects_absolute_traversal_backslash_and_git_internal_paths() {
        assert_eq!(
            validate_git_workspace_relative_path("notes/idea.md", GitServiceOperation::Diff)
                .unwrap(),
            "notes/idea.md"
        );

        for path in [
            "../notes.md",
            "notes/../../secret.md",
            "/Users/example/notes.md",
            "C:/Users/example/notes.md",
            "//server/share/notes.md",
            "notes\\idea.md",
            "notes//idea.md",
            ".git/config",
            "notes/.git/index",
        ] {
            let error =
                validate_git_workspace_relative_path(path, GitServiceOperation::Diff).unwrap_err();
            assert_eq!(error.code, GitOperationErrorCode::PermissionDenied);
        }
    }

    #[test]
    fn documents_operation_permission_matrix() {
        assert_eq!(
            git_operation_policy(
                GitRepositoryStateKind::DetachedHead,
                GitServiceOperation::Status
            )
            .access,
            GitOperationAccess::ReadOnly
        );
        assert_eq!(
            git_operation_policy(
                GitRepositoryStateKind::DetachedHead,
                GitServiceOperation::Snapshot
            )
            .blocked_by,
            Some(GitOperationErrorCode::DetachedHead)
        );
        assert_eq!(
            git_operation_policy(
                GitRepositoryStateKind::MergeConflict,
                GitServiceOperation::Restore
            )
            .blocked_by,
            Some(GitOperationErrorCode::MergeConflict)
        );
        assert_eq!(
            git_operation_policy(
                GitRepositoryStateKind::ParentRepository,
                GitServiceOperation::Diff
            )
            .access,
            GitOperationAccess::ReadOnly
        );
        assert!(!is_git_operation_allowed(
            GitRepositoryStateKind::BareRepository,
            GitServiceOperation::History
        ));
        assert!(is_git_operation_allowed(
            GitRepositoryStateKind::NestedRepository,
            GitServiceOperation::Restore
        ));
    }

    #[test]
    fn detects_stale_repository_tokens() {
        let expected = sample_token();
        assert!(!is_repository_token_stale(Some(&expected), Some(&expected)));

        let mut changed_head = expected.clone();
        changed_head.head_oid = Some("changed".to_owned());
        assert!(is_repository_token_stale(
            Some(&expected),
            Some(&changed_head)
        ));

        let mut changed_index = expected.clone();
        changed_index.index_version = Some(4);
        assert!(is_repository_token_stale(
            Some(&expected),
            Some(&changed_index)
        ));

        let mut changed_worktree = expected.clone();
        changed_worktree.worktree_status_generation = "dirty-0002".to_owned();
        assert!(is_repository_token_stale(
            Some(&expected),
            Some(&changed_worktree)
        ));
        assert!(is_repository_token_stale(Some(&expected), None));
    }
}
