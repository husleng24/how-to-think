use crate::ai::providers::{AiProviderSettings, AiProviderStore, AI_PROVIDER_SETTINGS_FILE};
use crate::cli_guard::{
    evaluate_cli_preflight, CliGuardBlockCode, CliPreflightDecision, CliPreflightRequest,
};
use crate::desktop_bridge::{
    CliUiAction, CliUiActionKind, DesktopBridgeAdapter, DesktopBridgeClient, DesktopBridgeProbe,
};
use crate::errors::{WorkspaceError, WorkspaceErrorCode, WorkspaceOperation};
use crate::models::Platform;
use crate::path_guard;
use crate::settings::{SettingsStore, WorkspaceSettings};
use crate::workspace;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::env;
use std::path::{Path, PathBuf};

pub const CLI_CONTRACT_VERSION: &str = "2026-05-10.v1";
pub const CLI_RESULT_SCHEMA_VERSION: &str = "1.0.0";
pub const WORKSPACE_SETTINGS_FILE: &str = "workspace-settings.json";
pub const APP_IDENTIFIER: &str = "ai.multica.howtothink";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandServicePaths {
    pub app_data_dir: PathBuf,
    pub app_config_dir: PathBuf,
}

#[derive(Debug, Clone)]
pub struct CommandService {
    paths: CommandServicePaths,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CliResultEnvelope {
    pub ok: bool,
    pub contract_version: &'static str,
    pub schema_version: &'static str,
    pub operation_id: String,
    pub data: Option<Value>,
    pub warnings: Vec<CliWarning>,
    pub error: Option<CliError>,
    pub needs_confirmation: Option<Value>,
    pub ui_action: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CliWarning {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<BTreeMap<String, Value>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CliError {
    pub code: CliErrorCode,
    pub message: String,
    pub recoverable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<BTreeMap<String, Value>>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CliErrorCode {
    ValidationError,
    InvalidArguments,
    InvalidOutputFormat,
    WorkspaceNotSelected,
    WorkspaceMissing,
    InvalidRelativePath,
    PathOutsideWorkspace,
    UnsupportedFileType,
    FileNotFound,
    VersionConflict,
    DirtyStateConflict,
    ExternalStateChanged,
    ConfirmationRequired,
    OperationCancelled,
    BackendUnavailable,
    ProviderNotConfigured,
    ProviderUnavailable,
    GitUnavailable,
    RepositoryBlocked,
    CommandUnavailable,
    UiRequired,
    UnsupportedOperation,
    InternalError,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HelpData {
    pub usage: String,
    pub commands: Vec<HelpCommand>,
    pub global_flags: Vec<HelpFlag>,
    pub contract_version: &'static str,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HelpCommand {
    pub name: &'static str,
    pub description: &'static str,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HelpFlag {
    pub name: &'static str,
    pub description: &'static str,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VersionData {
    pub package_name: &'static str,
    pub version: &'static str,
    pub contract_version: &'static str,
    pub schema_version: &'static str,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DoctorRequest {
    pub workspace_path: Option<PathBuf>,
    pub non_interactive: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DoctorReport {
    pub app_version: &'static str,
    pub contract_version: &'static str,
    pub schema_version: &'static str,
    pub app_data_dir: String,
    pub app_config_dir: String,
    pub non_interactive: bool,
    pub settings: DoctorSettingsSummary,
    pub desktop: DoctorDesktopSummary,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace: Option<DoctorWorkspaceSummary>,
    pub checks: Vec<DoctorCheck>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DoctorSettingsSummary {
    pub remembered_workspace_id: Option<String>,
    pub recent_workspace_count: usize,
    pub active_provider_id: Option<String>,
    pub provider_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DoctorDesktopSummary {
    pub running: bool,
    pub bridge_available: bool,
    pub dirty_document_count: usize,
    pub pending_ai_proposal_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_workspace_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DoctorWorkspaceSummary {
    pub id: String,
    pub display_name: String,
    pub display_path: String,
    pub file_count: usize,
    pub writable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DoctorCheck {
    pub id: &'static str,
    pub status: DoctorCheckStatus,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<BTreeMap<String, Value>>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DoctorCheckStatus {
    Ok,
    Warning,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct UiActionRequest {
    pub command_id: String,
    pub kind: CliUiActionKind,
    pub target: String,
    pub reason: String,
    pub non_interactive: bool,
}

impl CommandServicePaths {
    pub fn resolve(
        app_data_dir: Option<PathBuf>,
        app_config_dir: Option<PathBuf>,
    ) -> Result<Self, CliServiceError> {
        let app_data_dir = app_data_dir
            .or_else(|| env::var_os("HOW_TO_THINK_APP_DATA_DIR").map(PathBuf::from))
            .map(Ok)
            .unwrap_or_else(default_app_data_dir)?;
        let app_config_dir = app_config_dir
            .or_else(|| env::var_os("HOW_TO_THINK_APP_CONFIG_DIR").map(PathBuf::from))
            .map(Ok)
            .unwrap_or_else(default_app_config_dir)?;

        Ok(Self {
            app_data_dir,
            app_config_dir,
        })
    }
}

impl CommandService {
    pub fn new(paths: CommandServicePaths) -> Self {
        Self { paths }
    }

    pub fn help_data() -> HelpData {
        HelpData {
            usage: "how-to-think [--json] [--non-interactive] [--workspace <path>] <command>"
                .to_owned(),
            commands: vec![
                HelpCommand {
                    name: "help",
                    description: "Show CLI usage and global flags.",
                },
                HelpCommand {
                    name: "version",
                    description: "Print the CLI and contract versions.",
                },
                HelpCommand {
                    name: "doctor",
                    description: "Check command service, settings, and optional workspace access.",
                },
                HelpCommand {
                    name: "ui.open",
                    description:
                        "Return a desktop UI handoff for an app, workspace, or file target.",
                },
                HelpCommand {
                    name: "ui.focus",
                    description: "Return a desktop UI handoff for a file, node, or link target.",
                },
                HelpCommand {
                    name: "ui.review",
                    description: "Return a desktop review handoff for AI, Git, or conflict review.",
                },
            ],
            global_flags: vec![
                HelpFlag {
                    name: "--json",
                    description: "Print only the VIT-96 result envelope as JSON.",
                },
                HelpFlag {
                    name: "--format <human|json>",
                    description: "Select human or JSON output.",
                },
                HelpFlag {
                    name: "--workspace <path>",
                    description: "Provide a workspace path for commands that can inspect one.",
                },
                HelpFlag {
                    name: "--non-interactive",
                    description: "Return deterministic non-prompting results.",
                },
                HelpFlag {
                    name: "--target <target>",
                    description: "Provide a desktop UI handoff target.",
                },
                HelpFlag {
                    name: "--reason <text>",
                    description: "Explain why a desktop UI handoff is required.",
                },
                HelpFlag {
                    name: "--confirm-token <token>",
                    description: "Provide a typed confirmation token returned by preflight.",
                },
            ],
            contract_version: CLI_CONTRACT_VERSION,
        }
    }

    pub fn version_data() -> VersionData {
        VersionData {
            package_name: env!("CARGO_PKG_NAME"),
            version: env!("CARGO_PKG_VERSION"),
            contract_version: CLI_CONTRACT_VERSION,
            schema_version: CLI_RESULT_SCHEMA_VERSION,
        }
    }

    pub fn doctor(&self, request: DoctorRequest) -> DoctorReport {
        let mut checks = Vec::new();
        let mut settings = DoctorSettingsSummary {
            remembered_workspace_id: None,
            recent_workspace_count: 0,
            active_provider_id: None,
            provider_count: 0,
        };

        match self.validate_workspace_relative_path("doctor-smoke.md") {
            Ok(relative_path) => checks.push(DoctorCheck::ok(
                "path_guard",
                format!("Relative path validation accepted `{relative_path}`."),
            )),
            Err(error) => checks.push(DoctorCheck::from_workspace_error("path_guard", error)),
        }

        match workspace_settings_store(&self.paths.app_data_dir).load() {
            Ok(workspace_settings) => {
                settings.remembered_workspace_id = workspace_settings.remembered_workspace_id;
                settings.recent_workspace_count = workspace_settings.recent_workspaces.len();
                checks.push(DoctorCheck::ok(
                    "workspace_settings",
                    "Workspace settings are readable.",
                ));
            }
            Err(error) => checks.push(DoctorCheck::from_workspace_error(
                "workspace_settings",
                error,
            )),
        }

        match provider_settings_store(&self.paths.app_config_dir).load() {
            Ok(provider_settings) => {
                settings.active_provider_id = provider_settings.active_provider_id;
                settings.provider_count = provider_settings.providers.len();
                checks.push(DoctorCheck::ok(
                    "provider_settings",
                    "AI provider settings are readable.",
                ));
            }
            Err(error) => checks.push(DoctorCheck::error(
                "provider_settings",
                error.message,
                details([("code", json!(format!("{:?}", error.code)))]),
            )),
        }

        let desktop = match DesktopBridgeClient::new(&self.paths.app_data_dir).session_status() {
            DesktopBridgeProbe::NotRunning => {
                checks.push(DoctorCheck::ok(
                    "desktop_bridge",
                    "No running desktop bridge was detected.",
                ));
                DoctorDesktopSummary {
                    running: false,
                    bridge_available: false,
                    dirty_document_count: 0,
                    pending_ai_proposal_count: 0,
                    active_workspace_id: None,
                }
            }
            DesktopBridgeProbe::Running(status) => {
                checks.push(DoctorCheck::ok(
                    "desktop_bridge",
                    "Desktop bridge is reachable.",
                ));
                DoctorDesktopSummary {
                    running: status.running,
                    bridge_available: status.bridge_available,
                    dirty_document_count: status.dirty_documents.len(),
                    pending_ai_proposal_count: status.pending_ai_proposals.len(),
                    active_workspace_id: status
                        .active_workspace
                        .as_ref()
                        .map(|workspace| workspace.workspace_id.clone()),
                }
            }
            DesktopBridgeProbe::Unavailable(error) => {
                checks.push(DoctorCheck::error(
                    "desktop_bridge",
                    error.message,
                    details([("code", json!(format!("{:?}", error.code)))]),
                ));
                DoctorDesktopSummary {
                    running: true,
                    bridge_available: false,
                    dirty_document_count: 0,
                    pending_ai_proposal_count: 0,
                    active_workspace_id: None,
                }
            }
        };

        let workspace = request.workspace_path.as_ref().and_then(|workspace_path| {
            match workspace::load_workspace_session(
                workspace_path,
                WorkspaceOperation::SelectWorkspace,
            ) {
                Ok((_, session)) => {
                    checks.push(DoctorCheck::ok(
                        "workspace",
                        "Workspace path is readable and indexed.",
                    ));
                    Some(DoctorWorkspaceSummary {
                        id: session.workspace.id,
                        display_name: session.workspace.display_name,
                        display_path: session.workspace.display_path,
                        file_count: session.files.len(),
                        writable: session.workspace.writable,
                    })
                }
                Err(error) => {
                    checks.push(DoctorCheck::from_workspace_error("workspace", error));
                    None
                }
            }
        });

        DoctorReport {
            app_version: env!("CARGO_PKG_VERSION"),
            contract_version: CLI_CONTRACT_VERSION,
            schema_version: CLI_RESULT_SCHEMA_VERSION,
            app_data_dir: self.paths.app_data_dir.display().to_string(),
            app_config_dir: self.paths.app_config_dir.display().to_string(),
            non_interactive: request.non_interactive,
            settings,
            desktop,
            workspace,
            checks,
        }
    }

    pub fn validate_workspace_relative_path(
        &self,
        relative_path: &str,
    ) -> Result<String, WorkspaceError> {
        validate_workspace_relative_path(relative_path)
    }

    pub fn preflight(&self, request: CliPreflightRequest) -> CliResultEnvelope {
        let bridge = DesktopBridgeClient::new(&self.paths.app_data_dir);
        self.preflight_with_bridge(request, &bridge)
    }

    pub fn preflight_with_bridge<B: DesktopBridgeAdapter>(
        &self,
        request: CliPreflightRequest,
        bridge: &B,
    ) -> CliResultEnvelope {
        let operation_id = request.command_id.clone();
        let decision = evaluate_cli_preflight(request, bridge);
        CliResultEnvelope::from_preflight_decision(operation_id, decision)
    }

    pub fn request_desktop_ui(&self, request: UiActionRequest) -> CliResultEnvelope {
        let bridge = DesktopBridgeClient::new(&self.paths.app_data_dir);
        self.request_desktop_ui_with_bridge(request, &bridge)
    }

    pub fn request_desktop_ui_with_bridge<B: DesktopBridgeAdapter>(
        &self,
        request: UiActionRequest,
        bridge: &B,
    ) -> CliResultEnvelope {
        let action = CliUiAction::new(request.kind, request.target, request.reason);
        let delivered_action = match bridge.session_status() {
            DesktopBridgeProbe::Running(status) if status.can_handle_ui_action => {
                bridge.request_ui_action(action.clone()).unwrap_or(action)
            }
            _ => action,
        };

        CliResultEnvelope::ui_required(
            request.command_id,
            delivered_action,
            "The operation must continue in the desktop UI.",
        )
    }
}

impl CliResultEnvelope {
    pub fn success<T: Serialize>(operation_id: impl Into<String>, data: T) -> Self {
        Self {
            ok: true,
            contract_version: CLI_CONTRACT_VERSION,
            schema_version: CLI_RESULT_SCHEMA_VERSION,
            operation_id: operation_id.into(),
            data: Some(serde_json::to_value(data).unwrap_or(Value::Null)),
            warnings: Vec::new(),
            error: None,
            needs_confirmation: None,
            ui_action: None,
        }
    }

    pub fn error(
        operation_id: impl Into<String>,
        code: CliErrorCode,
        message: impl Into<String>,
    ) -> Self {
        Self {
            ok: false,
            contract_version: CLI_CONTRACT_VERSION,
            schema_version: CLI_RESULT_SCHEMA_VERSION,
            operation_id: operation_id.into(),
            data: None,
            warnings: Vec::new(),
            error: Some(CliError {
                code,
                message: message.into(),
                recoverable: is_recoverable_error(code),
                details: None,
            }),
            needs_confirmation: None,
            ui_action: None,
        }
    }

    pub fn confirmation_required(
        operation_id: impl Into<String>,
        confirmation: impl Serialize,
    ) -> Self {
        let mut envelope = Self::error(
            operation_id,
            CliErrorCode::ConfirmationRequired,
            "The operation requires explicit confirmation before it can continue.",
        );
        envelope.needs_confirmation =
            Some(serde_json::to_value(confirmation).unwrap_or(Value::Null));
        envelope
    }

    pub fn ui_required(
        operation_id: impl Into<String>,
        action: impl Serialize,
        message: impl Into<String>,
    ) -> Self {
        let mut envelope = Self::error(operation_id, CliErrorCode::UiRequired, message);
        envelope.ui_action = Some(serde_json::to_value(action).unwrap_or(Value::Null));
        envelope
    }

    pub fn from_preflight_decision(
        operation_id: impl Into<String>,
        decision: CliPreflightDecision,
    ) -> Self {
        let operation_id = operation_id.into();
        match decision {
            CliPreflightDecision::Proceed { approval } => Self::success(operation_id, approval),
            CliPreflightDecision::NeedsConfirmation { confirmation } => {
                Self::confirmation_required(operation_id, confirmation)
            }
            CliPreflightDecision::UiRequired { action } => Self::ui_required(
                operation_id,
                action,
                "The operation must continue in the desktop UI.",
            ),
            CliPreflightDecision::Blocked { block } => {
                let code = cli_error_code_for_guard_block(block.code);
                let mut envelope = Self::error(operation_id, code, block.message);
                if let Some(error) = &mut envelope.error {
                    error.details = block.details;
                }
                envelope
            }
        }
    }

    pub fn from_workspace_error(operation_id: impl Into<String>, error: WorkspaceError) -> Self {
        let code = cli_error_code_for_workspace_error(error.code);
        let mut envelope = Self::error(operation_id, code, error.message);
        if let Some(cli_error) = &mut envelope.error {
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
            cli_error.details = Some(details);
        }
        envelope
    }

    pub fn exit_code(&self) -> i32 {
        if self.ok {
            0
        } else {
            self.error
                .as_ref()
                .map(|error| exit_code_for_error_code(error.code))
                .unwrap_or(70)
        }
    }
}

impl DoctorCheck {
    fn ok(id: &'static str, message: impl Into<String>) -> Self {
        Self {
            id,
            status: DoctorCheckStatus::Ok,
            message: message.into(),
            details: None,
        }
    }

    fn error(
        id: &'static str,
        message: impl Into<String>,
        details: Option<BTreeMap<String, Value>>,
    ) -> Self {
        Self {
            id,
            status: DoctorCheckStatus::Error,
            message: message.into(),
            details,
        }
    }

    fn from_workspace_error(id: &'static str, error: WorkspaceError) -> Self {
        let mut details = error.details.unwrap_or_default();
        details.insert("code".to_owned(), json!(format!("{:?}", error.code)));
        details.insert(
            "operation".to_owned(),
            json!(format!("{:?}", error.operation)),
        );

        Self::error(id, error.message, Some(details))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CliServiceError {
    pub code: CliErrorCode,
    pub message: String,
}

impl CliServiceError {
    fn new(code: CliErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

pub fn workspace_settings_store(app_data_dir: impl AsRef<Path>) -> SettingsStore {
    SettingsStore::new(app_data_dir.as_ref().join(WORKSPACE_SETTINGS_FILE))
}

pub fn provider_settings_store(app_config_dir: impl AsRef<Path>) -> AiProviderStore {
    AiProviderStore::new(app_config_dir.as_ref().join(AI_PROVIDER_SETTINGS_FILE))
}

pub fn validate_workspace_relative_path(relative_path: &str) -> Result<String, WorkspaceError> {
    path_guard::validate_workspace_relative_path(
        relative_path,
        Platform::current().default_case_sensitive(),
        WorkspaceOperation::OpenFile,
    )
}

pub fn cli_error_code_for_workspace_error(code: WorkspaceErrorCode) -> CliErrorCode {
    match code {
        WorkspaceErrorCode::WorkspaceNotSelected => CliErrorCode::WorkspaceNotSelected,
        WorkspaceErrorCode::WorkspaceMissing => CliErrorCode::WorkspaceMissing,
        WorkspaceErrorCode::InvalidRelativePath => CliErrorCode::InvalidRelativePath,
        WorkspaceErrorCode::PathOutsideWorkspace => CliErrorCode::PathOutsideWorkspace,
        WorkspaceErrorCode::UnsupportedFileType => CliErrorCode::UnsupportedFileType,
        WorkspaceErrorCode::FileNotFound => CliErrorCode::FileNotFound,
        WorkspaceErrorCode::VersionConflict => CliErrorCode::VersionConflict,
        WorkspaceErrorCode::OperationCancelled => CliErrorCode::OperationCancelled,
        WorkspaceErrorCode::WatchUnavailable => CliErrorCode::BackendUnavailable,
        WorkspaceErrorCode::WorkspaceNotDirectory
        | WorkspaceErrorCode::WorkspaceUnwritable
        | WorkspaceErrorCode::PermissionDenied
        | WorkspaceErrorCode::InvalidWorkspacePath => CliErrorCode::ValidationError,
        WorkspaceErrorCode::InvalidAiContextRequest => CliErrorCode::ValidationError,
        WorkspaceErrorCode::FileAlreadyExists
        | WorkspaceErrorCode::InvalidUtf8
        | WorkspaceErrorCode::WriteFailed
        | WorkspaceErrorCode::DiskFull
        | WorkspaceErrorCode::RenameFailed
        | WorkspaceErrorCode::DeleteFailed
        | WorkspaceErrorCode::UnknownIoError => CliErrorCode::InternalError,
    }
}

pub fn cli_error_code_for_guard_block(code: CliGuardBlockCode) -> CliErrorCode {
    match code {
        CliGuardBlockCode::ValidationError => CliErrorCode::ValidationError,
        CliGuardBlockCode::VersionConflict => CliErrorCode::VersionConflict,
        CliGuardBlockCode::ExternalStateChanged => CliErrorCode::ExternalStateChanged,
        CliGuardBlockCode::BackendUnavailable => CliErrorCode::BackendUnavailable,
        CliGuardBlockCode::InternalError => CliErrorCode::InternalError,
    }
}

pub fn exit_code_for_error_code(code: CliErrorCode) -> i32 {
    match code {
        CliErrorCode::ValidationError
        | CliErrorCode::InvalidArguments
        | CliErrorCode::InvalidOutputFormat
        | CliErrorCode::WorkspaceNotSelected
        | CliErrorCode::WorkspaceMissing
        | CliErrorCode::InvalidRelativePath
        | CliErrorCode::PathOutsideWorkspace
        | CliErrorCode::UnsupportedFileType
        | CliErrorCode::FileNotFound => 10,
        CliErrorCode::VersionConflict
        | CliErrorCode::DirtyStateConflict
        | CliErrorCode::ExternalStateChanged
        | CliErrorCode::RepositoryBlocked => 20,
        CliErrorCode::ConfirmationRequired | CliErrorCode::OperationCancelled => 30,
        CliErrorCode::BackendUnavailable
        | CliErrorCode::ProviderNotConfigured
        | CliErrorCode::ProviderUnavailable
        | CliErrorCode::GitUnavailable => 40,
        CliErrorCode::CommandUnavailable
        | CliErrorCode::UiRequired
        | CliErrorCode::UnsupportedOperation => 50,
        CliErrorCode::InternalError => 70,
    }
}

fn is_recoverable_error(code: CliErrorCode) -> bool {
    !matches!(
        code,
        CliErrorCode::UnsupportedOperation | CliErrorCode::InternalError
    )
}

fn details<const N: usize>(entries: [(&str, Value); N]) -> Option<BTreeMap<String, Value>> {
    Some(
        entries
            .into_iter()
            .map(|(key, value)| (key.to_owned(), value))
            .collect(),
    )
}

fn default_app_data_dir() -> Result<PathBuf, CliServiceError> {
    platform_app_dir(DirectoryKind::Data)
}

fn default_app_config_dir() -> Result<PathBuf, CliServiceError> {
    platform_app_dir(DirectoryKind::Config)
}

#[derive(Debug, Clone, Copy)]
enum DirectoryKind {
    Data,
    Config,
}

fn platform_app_dir(_kind: DirectoryKind) -> Result<PathBuf, CliServiceError> {
    #[cfg(target_os = "windows")]
    {
        let base = env::var_os("APPDATA")
            .or_else(|| env::var_os("LOCALAPPDATA"))
            .ok_or_else(|| {
                CliServiceError::new(
                    CliErrorCode::BackendUnavailable,
                    "APPDATA or LOCALAPPDATA is required to locate app settings.",
                )
            })?;
        return Ok(PathBuf::from(base).join(APP_IDENTIFIER));
    }

    #[cfg(target_os = "macos")]
    {
        let home = env::var_os("HOME").ok_or_else(|| {
            CliServiceError::new(
                CliErrorCode::BackendUnavailable,
                "HOME is required to locate app settings.",
            )
        })?;
        return Ok(PathBuf::from(home)
            .join("Library")
            .join("Application Support")
            .join(APP_IDENTIFIER));
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let env_name = match _kind {
            DirectoryKind::Data => "XDG_DATA_HOME",
            DirectoryKind::Config => "XDG_CONFIG_HOME",
        };
        if let Some(base) = env::var_os(env_name) {
            return Ok(PathBuf::from(base).join(APP_IDENTIFIER));
        }

        let home = env::var_os("HOME").ok_or_else(|| {
            CliServiceError::new(
                CliErrorCode::BackendUnavailable,
                "HOME is required to locate app settings.",
            )
        })?;
        let base = match _kind {
            DirectoryKind::Data => PathBuf::from(home).join(".local").join("share"),
            DirectoryKind::Config => PathBuf::from(home).join(".config"),
        };
        Ok(base.join(APP_IDENTIFIER))
    }

    #[cfg(not(any(windows, unix, target_os = "macos")))]
    {
        Err(CliServiceError::new(
            CliErrorCode::BackendUnavailable,
            "This platform does not have a configured app settings location.",
        ))
    }
}

#[allow(dead_code)]
fn _assert_settings_types_are_shared(_: WorkspaceSettings, _: AiProviderSettings) {}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli_guard::{CliGuardedOperation, CliNonInteractivePromptBehavior};
    use crate::commands;
    use crate::desktop_bridge::{DesktopBridgeError, DesktopBridgeProbe, DesktopSessionStatus};

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

    #[test]
    fn success_envelope_matches_contract_fields() {
        let envelope = CliResultEnvelope::success("version", CommandService::version_data());
        let json = serde_json::to_value(&envelope).unwrap();

        assert_eq!(json["ok"], true);
        assert_eq!(json["contract_version"], CLI_CONTRACT_VERSION);
        assert_eq!(json["schema_version"], CLI_RESULT_SCHEMA_VERSION);
        assert_eq!(json["operation_id"], "version");
        assert!(json["data"].is_object());
        assert_eq!(json["error"], Value::Null);
        assert_eq!(json["needs_confirmation"], Value::Null);
        assert_eq!(json["ui_action"], Value::Null);
    }

    #[test]
    fn exit_codes_follow_vit96_classes() {
        assert_eq!(exit_code_for_error_code(CliErrorCode::InvalidArguments), 10);
        assert_eq!(exit_code_for_error_code(CliErrorCode::VersionConflict), 20);
        assert_eq!(
            exit_code_for_error_code(CliErrorCode::ConfirmationRequired),
            30
        );
        assert_eq!(
            exit_code_for_error_code(CliErrorCode::ProviderUnavailable),
            40
        );
        assert_eq!(exit_code_for_error_code(CliErrorCode::UiRequired), 50);
        assert_eq!(exit_code_for_error_code(CliErrorCode::InternalError), 70);
    }

    #[test]
    fn maps_workspace_errors_to_cli_error_codes() {
        assert_eq!(
            cli_error_code_for_workspace_error(WorkspaceErrorCode::InvalidRelativePath),
            CliErrorCode::InvalidRelativePath
        );
        assert_eq!(
            cli_error_code_for_workspace_error(WorkspaceErrorCode::VersionConflict),
            CliErrorCode::VersionConflict
        );
        assert_eq!(
            cli_error_code_for_workspace_error(WorkspaceErrorCode::WatchUnavailable),
            CliErrorCode::BackendUnavailable
        );
    }

    #[test]
    fn doctor_loads_missing_settings_as_empty_summaries() {
        let temp = tempfile::tempdir().unwrap();
        let paths = CommandServicePaths {
            app_data_dir: temp.path().join("data"),
            app_config_dir: temp.path().join("config"),
        };
        let service = CommandService::new(paths);

        let report = service.doctor(DoctorRequest {
            workspace_path: None,
            non_interactive: true,
        });

        assert_eq!(report.settings.recent_workspace_count, 0);
        assert_eq!(report.settings.provider_count, 0);
        assert!(
            report
                .checks
                .iter()
                .any(|check| check.id == "workspace_settings"
                    && check.status == DoctorCheckStatus::Ok)
        );
        assert!(report
            .checks
            .iter()
            .any(|check| check.id == "provider_settings" && check.status == DoctorCheckStatus::Ok));
        assert!(!report.desktop.running);
    }

    #[test]
    fn tauri_relative_path_command_uses_shared_service_result() {
        let paths = CommandServicePaths {
            app_data_dir: PathBuf::from("unused-data"),
            app_config_dir: PathBuf::from("unused-config"),
        };
        let service = CommandService::new(paths);

        assert_eq!(
            commands::validate_workspace_relative_path("notes/idea.md".to_owned()).unwrap(),
            service
                .validate_workspace_relative_path("notes/idea.md")
                .unwrap()
        );
    }

    #[test]
    fn preflight_confirmation_maps_to_result_envelope() {
        let paths = CommandServicePaths {
            app_data_dir: PathBuf::from("unused-data"),
            app_config_dir: PathBuf::from("unused-config"),
        };
        let service = CommandService::new(paths);
        let envelope = service.preflight_with_bridge(
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
            },
            &fake_bridge(DesktopBridgeProbe::NotRunning),
        );

        assert!(!envelope.ok);
        assert_eq!(
            envelope.error.as_ref().unwrap().code,
            CliErrorCode::ConfirmationRequired
        );
        let confirmation = envelope.needs_confirmation.unwrap();
        assert_eq!(confirmation["kind"], "destructive_file");
        assert_eq!(
            confirmation["non_interactive"],
            serde_json::to_value(CliNonInteractivePromptBehavior::ReturnConfirmationRequired)
                .unwrap()
        );
    }

    #[test]
    fn ui_handoff_maps_to_result_envelope() {
        let paths = CommandServicePaths {
            app_data_dir: PathBuf::from("unused-data"),
            app_config_dir: PathBuf::from("unused-config"),
        };
        let service = CommandService::new(paths);
        let envelope = service.request_desktop_ui_with_bridge(
            UiActionRequest {
                command_id: "ui.review".to_owned(),
                kind: CliUiActionKind::OpenReviewSurface,
                target: "workspace:workspace-1/file:notes.md".to_owned(),
                reason: "Review pending changes.".to_owned(),
                non_interactive: true,
            },
            &fake_bridge(DesktopBridgeProbe::Running(DesktopSessionStatus {
                running: true,
                bridge_available: true,
                can_handle_ui_action: true,
                ..DesktopSessionStatus::not_running()
            })),
        );

        assert!(!envelope.ok);
        assert_eq!(envelope.exit_code(), 50);
        assert_eq!(
            envelope.error.as_ref().unwrap().code,
            CliErrorCode::UiRequired
        );
        assert_eq!(envelope.ui_action.unwrap()["kind"], "open_review_surface");
    }
}
