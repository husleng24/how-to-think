use crate::ai::providers::{AiProviderSettings, AiProviderStore, AI_PROVIDER_SETTINGS_FILE};
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
    use crate::commands;

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
}
