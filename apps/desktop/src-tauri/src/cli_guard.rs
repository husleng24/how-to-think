use crate::desktop_bridge::{
    CliUiAction, CliUiActionKind, DesktopBridgeAdapter, DesktopBridgeProbe,
};
use crate::errors::{WorkspaceError, WorkspaceErrorCode, WorkspaceOperation};
use crate::fs_watch;
use crate::models::{
    DocumentExternalChangeType, FileVersion, WorkspaceId, WorkspaceRecord, WorkspaceRelativePath,
};
use crate::path_guard;
use crate::workspace;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::PathBuf;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CliConfirmationKind {
    DestructiveFile,
    DestructiveMindmap,
    AiApply,
    GitInit,
    GitSnapshot,
    GitRestore,
    MultiFileChange,
    LossyMarkdownWrite,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CliNonInteractivePromptBehavior {
    ReturnConfirmationRequired,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CliConfirmationRequest {
    pub kind: CliConfirmationKind,
    pub command_id: String,
    pub prompt: String,
    pub risks: Vec<String>,
    pub confirm_token: String,
    pub non_interactive: CliNonInteractivePromptBehavior,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CliConfirmationScope {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<WorkspaceId>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub relative_paths: Vec<WorkspaceRelativePath>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub expected_version_tokens: Vec<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub details: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CliConfirmationRequestInput {
    pub kind: CliConfirmationKind,
    pub command_id: String,
    pub prompt: String,
    pub risks: Vec<String>,
    pub scope: CliConfirmationScope,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CliGuardedOperation {
    ReadOnly,
    Mutating,
    DestructiveFile,
    DestructiveMindmap,
    AiApply,
    GitInit,
    GitSnapshot,
    GitRestore,
    MultiFileChange,
    LossyMarkdownWrite,
    UiRequired,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CliExpectedVersion {
    pub relative_path: WorkspaceRelativePath,
    pub version: FileVersion,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CliPreflightRequest {
    pub command_id: String,
    pub operation: CliGuardedOperation,
    pub workspace_path: Option<PathBuf>,
    pub workspace_id: Option<WorkspaceId>,
    pub relative_paths: Vec<WorkspaceRelativePath>,
    pub expected_versions: Vec<CliExpectedVersion>,
    pub confirmation_token: Option<String>,
    pub non_interactive: bool,
    pub risks: Vec<String>,
    pub ui_action: Option<CliUiAction>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CliPreflightApproval {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<WorkspaceId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_path: Option<String>,
    pub desktop_state: CliPreflightDesktopState,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CliPreflightDesktopState {
    NotRequired,
    NotRunning,
    RunningClean,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CliGuardBlockCode {
    ValidationError,
    VersionConflict,
    ExternalStateChanged,
    BackendUnavailable,
    InternalError,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CliPreflightBlock {
    pub code: CliGuardBlockCode,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<BTreeMap<String, Value>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "decision", rename_all = "snake_case")]
pub enum CliPreflightDecision {
    Proceed {
        approval: CliPreflightApproval,
    },
    NeedsConfirmation {
        confirmation: CliConfirmationRequest,
    },
    UiRequired {
        action: CliUiAction,
    },
    Blocked {
        block: CliPreflightBlock,
    },
}

impl CliPreflightRequest {
    pub fn read_only(command_id: impl Into<String>) -> Self {
        Self {
            command_id: command_id.into(),
            operation: CliGuardedOperation::ReadOnly,
            workspace_path: None,
            workspace_id: None,
            relative_paths: Vec::new(),
            expected_versions: Vec::new(),
            confirmation_token: None,
            non_interactive: true,
            risks: Vec::new(),
            ui_action: None,
        }
    }
}

pub fn evaluate_cli_preflight<B: DesktopBridgeAdapter>(
    request: CliPreflightRequest,
    bridge: &B,
) -> CliPreflightDecision {
    let workspace_record = match validate_workspace(&request) {
        Ok(record) => record,
        Err(block) => return CliPreflightDecision::Blocked { block },
    };
    let workspace_id = request.workspace_id.clone().or_else(|| {
        workspace_record
            .as_ref()
            .map(|record| record.info.id.clone())
    });
    let relative_paths = match validate_relative_paths(&request, workspace_record.as_ref()) {
        Ok(paths) => paths,
        Err(block) => return CliPreflightDecision::Blocked { block },
    };

    if let Err(block) = check_expected_versions(&request, workspace_record.as_ref()) {
        return CliPreflightDecision::Blocked { block };
    }

    if matches!(request.operation, CliGuardedOperation::UiRequired) {
        return CliPreflightDecision::UiRequired {
            action: request.ui_action.clone().unwrap_or_else(|| {
                default_ui_action(
                    &request.command_id,
                    workspace_id.as_deref(),
                    &relative_paths,
                    "The operation must continue in the desktop UI.",
                )
            }),
        };
    }

    let desktop_state = if request.operation.requires_clean_desktop() {
        match bridge.session_status() {
            DesktopBridgeProbe::NotRunning => CliPreflightDesktopState::NotRunning,
            DesktopBridgeProbe::Running(status) => {
                let dirty_conflicts =
                    status.dirty_conflicts(workspace_id.as_deref(), &relative_paths);
                if !dirty_conflicts.is_empty() {
                    return CliPreflightDecision::UiRequired {
                        action: default_ui_action(
                            &request.command_id,
                            workspace_id.as_deref(),
                            &relative_paths,
                            "The desktop has unsaved changes that must be reviewed before this operation can continue.",
                        ),
                    };
                }

                let proposal_conflicts =
                    status.proposal_conflicts(workspace_id.as_deref(), &relative_paths);
                if !proposal_conflicts.is_empty() {
                    return CliPreflightDecision::UiRequired {
                        action: default_ui_action(
                            &request.command_id,
                            workspace_id.as_deref(),
                            &relative_paths,
                            "The desktop has pending AI proposal review state for the requested files.",
                        ),
                    };
                }

                CliPreflightDesktopState::RunningClean
            }
            DesktopBridgeProbe::Unavailable(error) => {
                return CliPreflightDecision::UiRequired {
                    action: default_ui_action(
                        &request.command_id,
                        workspace_id.as_deref(),
                        &relative_paths,
                        format!(
                            "The desktop bridge could not verify live editor state: {}",
                            error.message
                        ),
                    ),
                };
            }
        }
    } else {
        CliPreflightDesktopState::NotRequired
    };

    if let Some(kind) = request.operation.confirmation_kind() {
        let confirmation = confirmation_request_for(CliConfirmationRequestInput {
            kind,
            command_id: request.command_id.clone(),
            prompt: confirmation_prompt(kind, &request.command_id),
            risks: confirmation_risks(kind, request.risks.clone()),
            scope: CliConfirmationScope {
                workspace_id: workspace_id.clone(),
                relative_paths: relative_paths.clone(),
                expected_version_tokens: request
                    .expected_versions
                    .iter()
                    .map(|check| check.version.token.clone())
                    .collect(),
                details: BTreeMap::new(),
            },
        });

        if request.confirmation_token.as_deref() != Some(confirmation.confirm_token.as_str()) {
            return CliPreflightDecision::NeedsConfirmation { confirmation };
        }
    }

    CliPreflightDecision::Proceed {
        approval: CliPreflightApproval {
            workspace_id,
            workspace_path: workspace_record
                .as_ref()
                .map(|record| record.canonical_root.display().to_string()),
            desktop_state,
        },
    }
}

pub fn confirmation_request_for(input: CliConfirmationRequestInput) -> CliConfirmationRequest {
    let confirm_token = confirmation_token_for(&input);
    CliConfirmationRequest {
        kind: input.kind,
        command_id: input.command_id.clone(),
        prompt: input.prompt,
        risks: input.risks,
        confirm_token,
        non_interactive: CliNonInteractivePromptBehavior::ReturnConfirmationRequired,
    }
}

pub fn confirmation_token_for(input: &CliConfirmationRequestInput) -> String {
    let serialized_scope =
        serde_json::to_string(&input.scope).expect("confirmation scopes must serialize");
    let mut hasher = Sha256::new();
    hasher.update(format!("{:?}", input.kind).as_bytes());
    hasher.update(input.command_id.as_bytes());
    hasher.update(serialized_scope.as_bytes());
    for risk in &input.risks {
        hasher.update(risk.as_bytes());
    }

    format!("confirm:{}", &format!("{:x}", hasher.finalize())[..32])
}

fn validate_workspace(
    request: &CliPreflightRequest,
) -> Result<Option<WorkspaceRecord>, CliPreflightBlock> {
    match request.workspace_path.as_ref() {
        Some(path) => workspace::validate_workspace_root(path, WorkspaceOperation::LoadWorkspace)
            .map(Some)
            .map_err(CliPreflightBlock::from_workspace_error),
        None if request.expected_versions.is_empty() => Ok(None),
        None => Err(CliPreflightBlock {
            code: CliGuardBlockCode::ValidationError,
            message: "A workspace path is required to validate file version preflight checks."
                .to_owned(),
            details: None,
        }),
    }
}

fn validate_relative_paths(
    request: &CliPreflightRequest,
    workspace_record: Option<&WorkspaceRecord>,
) -> Result<Vec<WorkspaceRelativePath>, CliPreflightBlock> {
    let case_sensitive = workspace_record
        .map(|record| record.info.case_sensitive)
        .unwrap_or_else(|| crate::models::Platform::current().default_case_sensitive());
    let operation = workspace_operation_for(request.operation);
    let mut paths = Vec::new();

    for relative_path in request.relative_paths.iter().chain(
        request
            .expected_versions
            .iter()
            .map(|check| &check.relative_path),
    ) {
        let validated =
            path_guard::validate_workspace_relative_path(relative_path, case_sensitive, operation)
                .map_err(CliPreflightBlock::from_workspace_error)?;
        if !paths.iter().any(|path| path == &validated) {
            paths.push(validated);
        }
    }

    Ok(paths)
}

fn check_expected_versions(
    request: &CliPreflightRequest,
    workspace_record: Option<&WorkspaceRecord>,
) -> Result<(), CliPreflightBlock> {
    let Some(record) = workspace_record else {
        return Ok(());
    };

    for check in &request.expected_versions {
        let status =
            fs_watch::document_external_change_status(record, &check.relative_path, &check.version)
                .map_err(CliPreflightBlock::from_workspace_error)?;

        if status.change_type != DocumentExternalChangeType::Unchanged {
            let mut details = BTreeMap::new();
            details.insert("relativePath".to_owned(), json!(status.relative_path));
            details.insert(
                "changeType".to_owned(),
                json!(format!("{:?}", status.change_type)),
            );
            if let Some(current_file) = status.current_file {
                details.insert("currentToken".to_owned(), json!(current_file.version.token));
            }
            if let Some(moved_to) = status.moved_to {
                details.insert("movedTo".to_owned(), json!(moved_to));
            }

            return Err(CliPreflightBlock {
                code: CliGuardBlockCode::ExternalStateChanged,
                message: "The file changed on disk after the expected version token was captured."
                    .to_owned(),
                details: Some(details),
            });
        }
    }

    Ok(())
}

fn default_ui_action(
    command_id: &str,
    workspace_id: Option<&str>,
    relative_paths: &[WorkspaceRelativePath],
    reason: impl Into<String>,
) -> CliUiAction {
    let target = match (workspace_id, relative_paths.is_empty()) {
        (Some(workspace_id), false) => {
            format!(
                "workspace:{workspace_id}/files:{}",
                relative_paths.join(",")
            )
        }
        (Some(workspace_id), true) => format!("workspace:{workspace_id}"),
        (None, _) => command_id.to_owned(),
    };

    CliUiAction::new(CliUiActionKind::OpenReviewSurface, target, reason)
}

fn confirmation_prompt(kind: CliConfirmationKind, command_id: &str) -> String {
    match kind {
        CliConfirmationKind::DestructiveFile => {
            format!("Confirm `{command_id}` before it changes workspace files.")
        }
        CliConfirmationKind::DestructiveMindmap => {
            format!("Confirm `{command_id}` before it changes mind map structure.")
        }
        CliConfirmationKind::AiApply => {
            "Confirm applying the AI proposal to workspace content.".to_owned()
        }
        CliConfirmationKind::GitInit => {
            "Confirm creating Git metadata in this workspace.".to_owned()
        }
        CliConfirmationKind::GitSnapshot => {
            "Confirm staging changes and creating a local Git snapshot.".to_owned()
        }
        CliConfirmationKind::GitRestore => {
            "Confirm restoring historical Git content into the working tree.".to_owned()
        }
        CliConfirmationKind::MultiFileChange => {
            "Confirm changing multiple workspace files.".to_owned()
        }
        CliConfirmationKind::LossyMarkdownWrite => {
            "Confirm saving Markdown output with known compatibility loss.".to_owned()
        }
    }
}

fn confirmation_risks(kind: CliConfirmationKind, risks: Vec<String>) -> Vec<String> {
    if !risks.is_empty() {
        return risks;
    }

    match kind {
        CliConfirmationKind::DestructiveFile => {
            vec!["Workspace files may be renamed, deleted, created, or overwritten.".to_owned()]
        }
        CliConfirmationKind::DestructiveMindmap => {
            vec!["Nodes or branches may be moved or deleted.".to_owned()]
        }
        CliConfirmationKind::AiApply => {
            vec!["AI-generated changes will modify user content.".to_owned()]
        }
        CliConfirmationKind::GitInit => {
            vec!["Git metadata will be created in the workspace.".to_owned()]
        }
        CliConfirmationKind::GitSnapshot => {
            vec!["Workspace changes may be staged and committed locally.".to_owned()]
        }
        CliConfirmationKind::GitRestore => {
            vec!["Historical content will be restored into the working tree.".to_owned()]
        }
        CliConfirmationKind::MultiFileChange => {
            vec!["More than one workspace file may change.".to_owned()]
        }
        CliConfirmationKind::LossyMarkdownWrite => {
            vec!["Some Markdown content may be rewritten or dropped.".to_owned()]
        }
    }
}

fn workspace_operation_for(operation: CliGuardedOperation) -> WorkspaceOperation {
    match operation {
        CliGuardedOperation::ReadOnly | CliGuardedOperation::UiRequired => {
            WorkspaceOperation::OpenFile
        }
        CliGuardedOperation::Mutating
        | CliGuardedOperation::AiApply
        | CliGuardedOperation::MultiFileChange
        | CliGuardedOperation::LossyMarkdownWrite => WorkspaceOperation::SaveFile,
        CliGuardedOperation::DestructiveFile => WorkspaceOperation::DeleteFile,
        CliGuardedOperation::DestructiveMindmap => WorkspaceOperation::SaveFile,
        CliGuardedOperation::GitInit
        | CliGuardedOperation::GitSnapshot
        | CliGuardedOperation::GitRestore => WorkspaceOperation::SaveFile,
    }
}

impl CliGuardedOperation {
    fn confirmation_kind(self) -> Option<CliConfirmationKind> {
        match self {
            CliGuardedOperation::DestructiveFile => Some(CliConfirmationKind::DestructiveFile),
            CliGuardedOperation::DestructiveMindmap => {
                Some(CliConfirmationKind::DestructiveMindmap)
            }
            CliGuardedOperation::AiApply => Some(CliConfirmationKind::AiApply),
            CliGuardedOperation::GitInit => Some(CliConfirmationKind::GitInit),
            CliGuardedOperation::GitSnapshot => Some(CliConfirmationKind::GitSnapshot),
            CliGuardedOperation::GitRestore => Some(CliConfirmationKind::GitRestore),
            CliGuardedOperation::MultiFileChange => Some(CliConfirmationKind::MultiFileChange),
            CliGuardedOperation::LossyMarkdownWrite => {
                Some(CliConfirmationKind::LossyMarkdownWrite)
            }
            CliGuardedOperation::ReadOnly
            | CliGuardedOperation::Mutating
            | CliGuardedOperation::UiRequired => None,
        }
    }

    fn requires_clean_desktop(self) -> bool {
        !matches!(
            self,
            CliGuardedOperation::ReadOnly | CliGuardedOperation::UiRequired
        )
    }
}

impl CliPreflightBlock {
    fn from_workspace_error(error: WorkspaceError) -> Self {
        let code = match error.code {
            WorkspaceErrorCode::VersionConflict => CliGuardBlockCode::VersionConflict,
            WorkspaceErrorCode::WatchUnavailable => CliGuardBlockCode::BackendUnavailable,
            WorkspaceErrorCode::UnknownIoError
            | WorkspaceErrorCode::WriteFailed
            | WorkspaceErrorCode::DiskFull
            | WorkspaceErrorCode::RenameFailed
            | WorkspaceErrorCode::DeleteFailed => CliGuardBlockCode::InternalError,
            _ => CliGuardBlockCode::ValidationError,
        };
        let mut details = error.details.unwrap_or_default();
        details.insert(
            "workspaceCode".to_owned(),
            json!(format!("{:?}", error.code)),
        );
        details.insert(
            "workspaceOperation".to_owned(),
            json!(format!("{:?}", error.operation)),
        );
        if let Some(relative_path) = error.relative_path {
            details.insert("relativePath".to_owned(), json!(relative_path));
        }

        Self {
            code,
            message: error.message,
            details: Some(details),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::desktop_bridge::{
        DesktopBridgeError, DesktopBridgeErrorCode, DesktopDirtyDocument, DesktopSessionStatus,
    };
    use crate::documents;

    #[derive(Debug, Clone)]
    struct FakeDesktopBridge {
        probe: DesktopBridgeProbe,
    }

    impl DesktopBridgeAdapter for FakeDesktopBridge {
        fn session_status(&self) -> DesktopBridgeProbe {
            self.probe.clone()
        }

        fn request_ui_action(
            &self,
            action: CliUiAction,
        ) -> Result<CliUiAction, DesktopBridgeError> {
            Ok(action)
        }
    }

    fn fake_bridge(probe: DesktopBridgeProbe) -> FakeDesktopBridge {
        FakeDesktopBridge { probe }
    }

    fn destructive_file_request() -> CliPreflightRequest {
        CliPreflightRequest {
            command_id: "workspace.file.delete".to_owned(),
            operation: CliGuardedOperation::DestructiveFile,
            workspace_path: None,
            workspace_id: Some("workspace-1".to_owned()),
            relative_paths: vec!["notes.md".to_owned()],
            expected_versions: Vec::new(),
            confirmation_token: None,
            non_interactive: true,
            risks: Vec::new(),
            ui_action: None,
        }
    }

    #[test]
    fn destructive_operation_returns_confirmation_metadata_without_prompting() {
        let decision = evaluate_cli_preflight(
            destructive_file_request(),
            &fake_bridge(DesktopBridgeProbe::NotRunning),
        );

        match decision {
            CliPreflightDecision::NeedsConfirmation { confirmation } => {
                assert_eq!(confirmation.kind, CliConfirmationKind::DestructiveFile);
                assert_eq!(confirmation.command_id, "workspace.file.delete");
                assert_eq!(
                    confirmation.non_interactive,
                    CliNonInteractivePromptBehavior::ReturnConfirmationRequired
                );
                assert!(confirmation.confirm_token.starts_with("confirm:"));
            }
            other => panic!("expected confirmation decision, got {other:?}"),
        }
    }

    #[test]
    fn matching_confirmation_token_allows_preflight_to_proceed() {
        let request = destructive_file_request();
        let token = match evaluate_cli_preflight(
            request.clone(),
            &fake_bridge(DesktopBridgeProbe::NotRunning),
        ) {
            CliPreflightDecision::NeedsConfirmation { confirmation } => confirmation.confirm_token,
            other => panic!("expected confirmation decision, got {other:?}"),
        };
        let mut confirmed = request;
        confirmed.confirmation_token = Some(token);

        let decision =
            evaluate_cli_preflight(confirmed, &fake_bridge(DesktopBridgeProbe::NotRunning));

        assert!(matches!(decision, CliPreflightDecision::Proceed { .. }));
    }

    #[test]
    fn dirty_desktop_state_delegates_to_ui_review_before_confirmation() {
        let status = DesktopSessionStatus {
            running: true,
            bridge_available: true,
            dirty_documents: vec![DesktopDirtyDocument {
                workspace_id: "workspace-1".to_owned(),
                relative_path: "notes.md".to_owned(),
                last_disk_version: None,
            }],
            ..DesktopSessionStatus::not_running()
        };

        let decision = evaluate_cli_preflight(
            destructive_file_request(),
            &fake_bridge(DesktopBridgeProbe::Running(status)),
        );

        match decision {
            CliPreflightDecision::UiRequired { action } => {
                assert_eq!(action.kind, CliUiActionKind::OpenReviewSurface);
                assert!(action.reason.contains("unsaved changes"));
            }
            other => panic!("expected UI handoff decision, got {other:?}"),
        }
    }

    #[test]
    fn unavailable_desktop_bridge_delegates_mutating_operations_to_ui() {
        let decision = evaluate_cli_preflight(
            destructive_file_request(),
            &fake_bridge(DesktopBridgeProbe::Unavailable(DesktopBridgeError::new(
                DesktopBridgeErrorCode::EndpointUnavailable,
                "stale descriptor",
            ))),
        );

        assert!(matches!(decision, CliPreflightDecision::UiRequired { .. }));
    }

    #[test]
    fn read_only_operation_proceeds_when_desktop_is_unavailable() {
        let decision = evaluate_cli_preflight(
            CliPreflightRequest::read_only("workspace.file.open"),
            &fake_bridge(DesktopBridgeProbe::Unavailable(DesktopBridgeError::new(
                DesktopBridgeErrorCode::EndpointUnavailable,
                "stale descriptor",
            ))),
        );

        assert!(matches!(decision, CliPreflightDecision::Proceed { .. }));
    }

    #[test]
    fn expected_version_change_blocks_preflight() {
        let temp = tempfile::tempdir().unwrap();
        let record =
            workspace::validate_workspace_root(temp.path(), WorkspaceOperation::LoadWorkspace)
                .unwrap();
        let snapshot = documents::create_document(&record, "notes.md", Some("old".into())).unwrap();
        std::fs::write(temp.path().join("notes.md"), "external").unwrap();

        let decision = evaluate_cli_preflight(
            CliPreflightRequest {
                command_id: "workspace.file.save".to_owned(),
                operation: CliGuardedOperation::Mutating,
                workspace_path: Some(temp.path().to_path_buf()),
                workspace_id: Some(record.info.id),
                relative_paths: vec!["notes.md".to_owned()],
                expected_versions: vec![CliExpectedVersion {
                    relative_path: "notes.md".to_owned(),
                    version: snapshot.version,
                }],
                confirmation_token: None,
                non_interactive: true,
                risks: Vec::new(),
                ui_action: None,
            },
            &fake_bridge(DesktopBridgeProbe::NotRunning),
        );

        match decision {
            CliPreflightDecision::Blocked { block } => {
                assert_eq!(block.code, CliGuardBlockCode::ExternalStateChanged);
            }
            other => panic!("expected blocked decision, got {other:?}"),
        }
    }

    #[test]
    fn mutating_command_fixture_runs_preflight_before_mutation() {
        let request = destructive_file_request();
        let mut mutation_called = false;

        let decision =
            evaluate_cli_preflight(request, &fake_bridge(DesktopBridgeProbe::NotRunning));
        if matches!(decision, CliPreflightDecision::Proceed { .. }) {
            mutation_called = true;
        }

        assert!(!mutation_called);
    }
}
