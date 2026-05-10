use crate::atomic_write::write_file_atomically;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::env;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

const AI_PROVIDER_SETTINGS_FILE: &str = "ai-providers.json";
const DEFAULT_TIMEOUT_SECONDS: u64 = 30;
const MIN_TIMEOUT_SECONDS: u64 = 1;
const MAX_TIMEOUT_SECONDS: u64 = 600;
const DEFAULT_MAX_OUTPUT_BYTES: usize = 64 * 1024;
const MIN_MAX_OUTPUT_BYTES: usize = 1024;
const MAX_MAX_OUTPUT_BYTES: usize = 1024 * 1024;
const MAX_DISPLAY_NAME_CHARS: usize = 80;
const MAX_PROVIDER_ID_CHARS: usize = 96;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AiProviderKind {
    Codex,
    Claude,
    Generic,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiProviderConfig {
    pub id: String,
    pub display_name: String,
    pub kind: AiProviderKind,
    pub executable_path: String,
    #[serde(default)]
    pub argument_template: Vec<String>,
    #[serde(default)]
    pub health_check_args: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub environment_allowlist: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub working_directory: Option<String>,
    #[serde(default = "default_timeout_seconds")]
    pub timeout_seconds: u64,
    #[serde(default = "default_max_output_bytes")]
    pub max_output_bytes: usize,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_health_status: Option<AiProviderHealthStatus>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiProviderConfigInput {
    #[serde(default)]
    pub id: Option<String>,
    pub display_name: String,
    pub kind: AiProviderKind,
    pub executable_path: String,
    #[serde(default)]
    pub argument_template: Vec<String>,
    #[serde(default)]
    pub health_check_args: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub environment_allowlist: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub working_directory: Option<String>,
    #[serde(default = "default_timeout_seconds")]
    pub timeout_seconds: u64,
    #[serde(default = "default_max_output_bytes")]
    pub max_output_bytes: usize,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiProviderSettings {
    #[serde(default)]
    pub active_provider_id: Option<String>,
    #[serde(default)]
    pub providers: Vec<AiProviderConfig>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AiProviderHealthState {
    Unknown,
    Ok,
    MissingExecutable,
    PermissionDenied,
    AuthRequired,
    Timeout,
    NonZeroExit,
    InvalidConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiProviderHealthStatus {
    pub status: AiProviderHealthState,
    pub checked_at: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u128>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AiProviderErrorCode {
    MissingExecutable,
    NonExecutablePath,
    ShellCommandString,
    UnsafeWorkingDirectory,
    InvalidProviderId,
    InvalidDisplayName,
    InvalidArguments,
    InvalidEnvironmentAllowlist,
    InvalidTimeout,
    InvalidOutputLimit,
    ProviderNotFound,
    ProviderDisabled,
    PersistenceFailed,
    RuntimeUnavailable,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiProviderError {
    pub code: AiProviderErrorCode,
    pub message: String,
    pub recoverable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone)]
pub struct AiProviderStore {
    path: PathBuf,
}

#[tauri::command]
pub fn list_ai_providers(app: AppHandle) -> Result<AiProviderSettings, AiProviderError> {
    provider_store(&app)?.load()
}

#[tauri::command]
pub fn save_ai_provider(
    app: AppHandle,
    provider: AiProviderConfigInput,
) -> Result<AiProviderSettings, AiProviderError> {
    let store = provider_store(&app)?;
    let mut settings = store.load()?;
    let provider = provider.into_config(None)?;
    upsert_provider(&mut settings, provider)?;
    store.save(&settings)?;
    Ok(settings)
}

#[tauri::command]
pub fn select_ai_provider(
    app: AppHandle,
    provider_id: Option<String>,
) -> Result<AiProviderSettings, AiProviderError> {
    let store = provider_store(&app)?;
    let mut settings = store.load()?;
    select_provider(&mut settings, provider_id)?;
    store.save(&settings)?;
    Ok(settings)
}

#[tauri::command]
pub fn remove_ai_provider(
    app: AppHandle,
    provider_id: String,
) -> Result<AiProviderSettings, AiProviderError> {
    let store = provider_store(&app)?;
    let mut settings = store.load()?;
    remove_provider(&mut settings, &provider_id)?;
    store.save(&settings)?;
    Ok(settings)
}

#[tauri::command]
pub fn check_ai_provider_health(
    app: AppHandle,
    provider_id: String,
) -> Result<AiProviderHealthStatus, AiProviderError> {
    let store = provider_store(&app)?;
    let mut settings = store.load()?;
    let provider = settings
        .providers
        .iter()
        .find(|provider| provider.id == provider_id)
        .cloned()
        .ok_or_else(|| provider_not_found(&provider_id))?;
    let status = check_provider_health(&provider);

    if let Some(stored_provider) = settings
        .providers
        .iter_mut()
        .find(|stored_provider| stored_provider.id == provider_id)
    {
        stored_provider.last_health_status = Some(status.clone());
    }

    store.save(&settings)?;
    Ok(status)
}

impl AiProviderConfigInput {
    pub fn into_config(
        self,
        last_health_status: Option<AiProviderHealthStatus>,
    ) -> Result<AiProviderConfig, AiProviderError> {
        let id = match normalized_optional_string(self.id) {
            Some(id) => id,
            None => generate_provider_id(self.kind, &self.display_name),
        };
        let health_check_args = normalized_args(self.health_check_args);
        let mut provider = AiProviderConfig {
            id,
            display_name: self.display_name.trim().to_owned(),
            kind: self.kind,
            executable_path: self.executable_path.trim().to_owned(),
            argument_template: normalized_args(self.argument_template),
            health_check_args: if health_check_args.is_empty() {
                default_health_check_args(self.kind)
            } else {
                health_check_args
            },
            environment_allowlist: normalize_environment_allowlist(self.environment_allowlist),
            working_directory: normalized_optional_string(self.working_directory),
            timeout_seconds: self.timeout_seconds,
            max_output_bytes: self.max_output_bytes,
            enabled: self.enabled,
            last_health_status,
        };

        validate_provider_config(&provider)?;
        provider.argument_template = normalized_args(provider.argument_template);
        provider.health_check_args = normalized_args(provider.health_check_args);
        Ok(provider)
    }
}

impl AiProviderStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    pub fn load(&self) -> Result<AiProviderSettings, AiProviderError> {
        if !self.path.exists() {
            return Ok(AiProviderSettings::default());
        }

        let content = fs::read_to_string(&self.path).map_err(|error| {
            persistence_error("AI provider settings could not be read.", &self.path, error)
        })?;
        let mut settings: AiProviderSettings = serde_json::from_str(&content).map_err(|error| {
            AiProviderError::new(
                AiProviderErrorCode::PersistenceFailed,
                "AI provider settings could not be parsed.",
                true,
            )
            .with_field("settingsPath")
            .with_detail(format!("{}: {error}", self.path.display()))
        })?;

        if settings
            .active_provider_id
            .as_ref()
            .is_some_and(|active_id| {
                !settings
                    .providers
                    .iter()
                    .any(|provider| provider.id == *active_id)
            })
        {
            settings.active_provider_id = None;
        }

        Ok(settings)
    }

    pub fn save(&self, settings: &AiProviderSettings) -> Result<(), AiProviderError> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                persistence_error(
                    "AI provider settings directory could not be created.",
                    &self.path,
                    error,
                )
            })?;
        }

        let content = serde_json::to_vec_pretty(settings).map_err(|error| {
            AiProviderError::new(
                AiProviderErrorCode::PersistenceFailed,
                "AI provider settings could not be serialized.",
                true,
            )
            .with_detail(error.to_string())
        })?;

        write_file_atomically(&self.path, &content).map_err(|error| {
            persistence_error(
                "AI provider settings could not be saved.",
                &self.path,
                error,
            )
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

pub fn upsert_provider(
    settings: &mut AiProviderSettings,
    provider: AiProviderConfig,
) -> Result<(), AiProviderError> {
    validate_provider_config(&provider)?;

    if let Some(existing_provider) = settings
        .providers
        .iter_mut()
        .find(|existing_provider| existing_provider.id == provider.id)
    {
        *existing_provider = provider;
    } else {
        settings.providers.push(provider);
    }

    if settings.active_provider_id.is_none()
        && settings.providers.iter().any(|candidate| candidate.enabled)
    {
        settings.active_provider_id = settings
            .providers
            .iter()
            .find(|candidate| candidate.enabled)
            .map(|candidate| candidate.id.clone());
    }

    Ok(())
}

pub fn select_provider(
    settings: &mut AiProviderSettings,
    provider_id: Option<String>,
) -> Result<(), AiProviderError> {
    let Some(provider_id) = normalized_optional_string(provider_id) else {
        settings.active_provider_id = None;
        return Ok(());
    };

    let provider = settings
        .providers
        .iter()
        .find(|provider| provider.id == provider_id)
        .ok_or_else(|| provider_not_found(&provider_id))?;

    if !provider.enabled {
        return Err(AiProviderError::new(
            AiProviderErrorCode::ProviderDisabled,
            "Disabled AI providers cannot be selected.",
            true,
        )
        .with_field("providerId"));
    }

    settings.active_provider_id = Some(provider_id);
    Ok(())
}

pub fn remove_provider(
    settings: &mut AiProviderSettings,
    provider_id: &str,
) -> Result<(), AiProviderError> {
    let original_len = settings.providers.len();
    settings
        .providers
        .retain(|provider| provider.id != provider_id);

    if settings.providers.len() == original_len {
        return Err(provider_not_found(provider_id));
    }

    if settings.active_provider_id.as_deref() == Some(provider_id) {
        settings.active_provider_id = settings
            .providers
            .iter()
            .find(|provider| provider.enabled)
            .map(|provider| provider.id.clone());
    }

    Ok(())
}

pub fn validate_provider_config(provider: &AiProviderConfig) -> Result<(), AiProviderError> {
    validate_provider_id(&provider.id)?;
    validate_display_name(&provider.display_name)?;
    validate_timeout(provider.timeout_seconds)?;
    validate_max_output_bytes(provider.max_output_bytes)?;
    validate_arguments("argumentTemplate", &provider.argument_template)?;
    validate_arguments("healthCheckArgs", &provider.health_check_args)?;
    validate_environment_allowlist(provider.environment_allowlist.as_deref())?;
    validate_working_directory(provider.working_directory.as_deref())?;
    validate_executable_path(&provider.executable_path)?;
    Ok(())
}

pub fn check_provider_health(provider: &AiProviderConfig) -> AiProviderHealthStatus {
    let started = Utc::now().to_rfc3339();
    let timer = Instant::now();

    if !provider.enabled {
        return AiProviderHealthStatus {
            status: AiProviderHealthState::InvalidConfig,
            checked_at: started,
            message: "Enable this provider before running a health check.".to_owned(),
            detail: None,
            exit_code: None,
            duration_ms: Some(timer.elapsed().as_millis()),
        };
    }

    if let Err(error) = validate_provider_config(provider) {
        return health_status_from_config_error(error, started, timer.elapsed().as_millis());
    }

    match run_provider_health_command(provider, timer) {
        Ok(output) if output.status.success() => AiProviderHealthStatus {
            status: AiProviderHealthState::Ok,
            checked_at: started,
            message: success_health_message(&output),
            detail: output_detail(&output, provider.max_output_bytes),
            exit_code: output.status.code(),
            duration_ms: Some(timer.elapsed().as_millis()),
        },
        Ok(output) => {
            classify_non_zero_health(provider, &output, started, timer.elapsed().as_millis())
        }
        Err(HealthRunError::Timeout) => AiProviderHealthStatus {
            status: AiProviderHealthState::Timeout,
            checked_at: started,
            message: format!(
                "The provider did not finish within {} seconds.",
                provider.timeout_seconds
            ),
            detail: None,
            exit_code: None,
            duration_ms: Some(timer.elapsed().as_millis()),
        },
        Err(HealthRunError::Io(error)) => {
            health_status_from_io_error(error, started, timer.elapsed().as_millis())
        }
    }
}

pub(crate) fn provider_store(app: &AppHandle) -> Result<AiProviderStore, AiProviderError> {
    let settings_dir = app.path().app_config_dir().map_err(|error| {
        AiProviderError::new(
            AiProviderErrorCode::RuntimeUnavailable,
            "The app configuration directory is unavailable.",
            true,
        )
        .with_detail(error.to_string())
    })?;

    Ok(AiProviderStore::new(
        settings_dir.join(AI_PROVIDER_SETTINGS_FILE),
    ))
}

fn run_provider_health_command(
    provider: &AiProviderConfig,
    timer: Instant,
) -> Result<Output, HealthRunError> {
    let mut command = Command::new(&provider.executable_path);
    command
        .args(&provider.health_check_args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if let Some(working_directory) = &provider.working_directory {
        command.current_dir(working_directory);
    }

    if let Some(environment_allowlist) = &provider.environment_allowlist {
        command.env_clear();
        for name in environment_allowlist {
            if let Ok(value) = env::var(name) {
                command.env(name, value);
            }
        }
    }

    let mut child = command.spawn().map_err(HealthRunError::Io)?;
    let timeout = Duration::from_secs(provider.timeout_seconds);
    loop {
        match child.try_wait().map_err(HealthRunError::Io)? {
            Some(_) => return child.wait_with_output().map_err(HealthRunError::Io),
            None if timer.elapsed() >= timeout => {
                let _ = child.kill();
                let _ = child.wait_with_output();
                return Err(HealthRunError::Timeout);
            }
            None => thread::sleep(Duration::from_millis(20)),
        }
    }
}

fn classify_non_zero_health(
    provider: &AiProviderConfig,
    output: &Output,
    checked_at: String,
    duration_ms: u128,
) -> AiProviderHealthStatus {
    let detail = output_detail(output, provider.max_output_bytes);
    let normalized = detail.as_deref().unwrap_or_default().to_ascii_lowercase();

    let (status, message) = if contains_permission_denied_signal(&normalized) {
        (
            AiProviderHealthState::PermissionDenied,
            "The provider started, but the operating system denied access to a required local resource.",
        )
    } else if contains_auth_failure_signal(&normalized) {
        (
            AiProviderHealthState::AuthRequired,
            "The provider reported that local authentication or login is required.",
        )
    } else {
        (
            AiProviderHealthState::NonZeroExit,
            "The provider health command exited with a non-zero status.",
        )
    };

    AiProviderHealthStatus {
        status,
        checked_at,
        message: message.to_owned(),
        detail,
        exit_code: output.status.code(),
        duration_ms: Some(duration_ms),
    }
}

fn health_status_from_config_error(
    error: AiProviderError,
    checked_at: String,
    duration_ms: u128,
) -> AiProviderHealthStatus {
    let status = match error.code {
        AiProviderErrorCode::MissingExecutable => AiProviderHealthState::MissingExecutable,
        AiProviderErrorCode::NonExecutablePath => AiProviderHealthState::PermissionDenied,
        _ => AiProviderHealthState::InvalidConfig,
    };

    AiProviderHealthStatus {
        status,
        checked_at,
        message: error.message,
        detail: error.detail,
        exit_code: None,
        duration_ms: Some(duration_ms),
    }
}

fn health_status_from_io_error(
    error: io::Error,
    checked_at: String,
    duration_ms: u128,
) -> AiProviderHealthStatus {
    let (status, message) = match error.kind() {
        io::ErrorKind::NotFound => (
            AiProviderHealthState::MissingExecutable,
            "The provider executable could not be found.",
        ),
        io::ErrorKind::PermissionDenied => (
            AiProviderHealthState::PermissionDenied,
            "The operating system denied permission to run the provider executable.",
        ),
        _ => (
            AiProviderHealthState::Unknown,
            "The provider health check failed before a process result was available.",
        ),
    };

    AiProviderHealthStatus {
        status,
        checked_at,
        message: message.to_owned(),
        detail: Some(error.to_string()),
        exit_code: None,
        duration_ms: Some(duration_ms),
    }
}

fn success_health_message(output: &Output) -> String {
    output_detail(output, 240)
        .and_then(|detail| {
            detail
                .lines()
                .find(|line| !line.trim().is_empty())
                .map(|line| format!("Provider responded: {}", line.trim()))
        })
        .unwrap_or_else(|| "Provider health check completed successfully.".to_owned())
}

fn output_detail(output: &Output, max_bytes: usize) -> Option<String> {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&output.stdout);
    if !output.stderr.is_empty() {
        if !bytes.is_empty() {
            bytes.push(b'\n');
        }
        bytes.extend_from_slice(&output.stderr);
    }

    if bytes.is_empty() {
        return None;
    }

    if bytes.len() > max_bytes {
        bytes.truncate(max_bytes);
    }

    Some(String::from_utf8_lossy(&bytes).trim().to_owned()).filter(|detail| !detail.is_empty())
}

fn validate_provider_id(id: &str) -> Result<(), AiProviderError> {
    if id.trim().is_empty()
        || id.chars().count() > MAX_PROVIDER_ID_CHARS
        || !id.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | ':' | '.')
        })
    {
        return Err(AiProviderError::new(
            AiProviderErrorCode::InvalidProviderId,
            "Provider id must be a stable ASCII identifier.",
            true,
        )
        .with_field("id"));
    }

    Ok(())
}

fn validate_display_name(display_name: &str) -> Result<(), AiProviderError> {
    let name = display_name.trim();
    if name.is_empty() || name.chars().count() > MAX_DISPLAY_NAME_CHARS {
        return Err(AiProviderError::new(
            AiProviderErrorCode::InvalidDisplayName,
            "Provider display name must be between 1 and 80 characters.",
            true,
        )
        .with_field("displayName"));
    }

    Ok(())
}

fn validate_timeout(timeout_seconds: u64) -> Result<(), AiProviderError> {
    if !(MIN_TIMEOUT_SECONDS..=MAX_TIMEOUT_SECONDS).contains(&timeout_seconds) {
        return Err(AiProviderError::new(
            AiProviderErrorCode::InvalidTimeout,
            "Provider timeout must be between 1 and 600 seconds.",
            true,
        )
        .with_field("timeoutSeconds"));
    }

    Ok(())
}

fn validate_max_output_bytes(max_output_bytes: usize) -> Result<(), AiProviderError> {
    if !(MIN_MAX_OUTPUT_BYTES..=MAX_MAX_OUTPUT_BYTES).contains(&max_output_bytes) {
        return Err(AiProviderError::new(
            AiProviderErrorCode::InvalidOutputLimit,
            "Provider output limit must be between 1024 bytes and 1 MiB.",
            true,
        )
        .with_field("maxOutputBytes"));
    }

    Ok(())
}

fn validate_arguments(field: &str, arguments: &[String]) -> Result<(), AiProviderError> {
    for argument in arguments {
        if argument.is_empty()
            || argument.contains('\0')
            || argument.contains('\n')
            || argument.contains('\r')
            || is_shell_control_token(argument)
        {
            return Err(AiProviderError::new(
                AiProviderErrorCode::InvalidArguments,
                "Provider arguments must be structured argv entries, not shell control syntax.",
                true,
            )
            .with_field(field));
        }
    }

    Ok(())
}

fn validate_environment_allowlist(allowlist: Option<&[String]>) -> Result<(), AiProviderError> {
    let Some(allowlist) = allowlist else {
        return Ok(());
    };
    let mut seen = BTreeSet::new();

    for name in allowlist {
        if name.is_empty()
            || !name
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || character == '_')
            || name
                .chars()
                .next()
                .is_some_and(|character| character.is_ascii_digit())
            || !seen.insert(name)
        {
            return Err(AiProviderError::new(
                AiProviderErrorCode::InvalidEnvironmentAllowlist,
                "Environment allowlist entries must be unique variable names.",
                true,
            )
            .with_field("environmentAllowlist"));
        }
    }

    Ok(())
}

fn validate_working_directory(working_directory: Option<&str>) -> Result<(), AiProviderError> {
    let Some(working_directory) = working_directory else {
        return Ok(());
    };

    if looks_like_shell_command(working_directory) {
        return Err(AiProviderError::new(
            AiProviderErrorCode::UnsafeWorkingDirectory,
            "Working directory must be a single filesystem path, not a shell command.",
            true,
        )
        .with_field("workingDirectory"));
    }

    let path = Path::new(working_directory);
    if !path.is_absolute() || !path.exists() || !path.is_dir() {
        return Err(AiProviderError::new(
            AiProviderErrorCode::UnsafeWorkingDirectory,
            "Working directory must be an existing absolute directory.",
            true,
        )
        .with_field("workingDirectory"));
    }

    let canonical = fs::canonicalize(path).map_err(|error| {
        AiProviderError::new(
            AiProviderErrorCode::UnsafeWorkingDirectory,
            "Working directory could not be resolved.",
            true,
        )
        .with_field("workingDirectory")
        .with_detail(error.to_string())
    })?;

    if canonical.parent().is_none() {
        return Err(AiProviderError::new(
            AiProviderErrorCode::UnsafeWorkingDirectory,
            "Filesystem roots cannot be used as provider working directories.",
            true,
        )
        .with_field("workingDirectory"));
    }

    Ok(())
}

fn validate_executable_path(executable_path: &str) -> Result<(), AiProviderError> {
    if executable_path.trim().is_empty() {
        return Err(AiProviderError::new(
            AiProviderErrorCode::MissingExecutable,
            "Choose a local executable path for this provider.",
            true,
        )
        .with_field("executablePath"));
    }

    if looks_like_shell_command(executable_path) {
        return Err(AiProviderError::new(
            AiProviderErrorCode::ShellCommandString,
            "Executable path must be a single path without shell operators or inline arguments.",
            true,
        )
        .with_field("executablePath"));
    }

    let path = Path::new(executable_path);
    if !path.exists() {
        return Err(AiProviderError::new(
            AiProviderErrorCode::MissingExecutable,
            "The configured provider executable does not exist.",
            true,
        )
        .with_field("executablePath"));
    }

    let metadata = fs::metadata(path).map_err(|error| {
        AiProviderError::new(
            AiProviderErrorCode::MissingExecutable,
            "The configured provider executable could not be inspected.",
            true,
        )
        .with_field("executablePath")
        .with_detail(error.to_string())
    })?;

    if !metadata.is_file() || !is_executable_file(path, &metadata) {
        return Err(AiProviderError::new(
            AiProviderErrorCode::NonExecutablePath,
            "The configured provider path is not an executable file.",
            true,
        )
        .with_field("executablePath"));
    }

    Ok(())
}

#[cfg(unix)]
fn is_executable_file(_path: &Path, metadata: &fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;

    metadata.permissions().mode() & 0o111 != 0
}

#[cfg(windows)]
fn is_executable_file(path: &Path, _metadata: &fs::Metadata) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "exe" | "cmd" | "bat" | "com"
            )
        })
        .unwrap_or(false)
}

#[cfg(not(any(unix, windows)))]
fn is_executable_file(_path: &Path, _metadata: &fs::Metadata) -> bool {
    true
}

fn looks_like_shell_command(value: &str) -> bool {
    let value = value.trim();
    if value.contains('\0')
        || value.contains('\n')
        || value.contains('\r')
        || value.contains("&&")
        || value.contains("||")
        || value.contains('|')
        || value.contains(';')
        || value.contains('<')
        || value.contains('>')
        || value.contains('`')
    {
        return true;
    }

    value.split_whitespace().count() > 1 && !Path::new(value).exists()
}

fn is_shell_control_token(argument: &str) -> bool {
    matches!(
        argument.trim(),
        "&&" | "||" | "|" | ";" | "<" | ">" | "2>" | "1>" | "&"
    )
}

fn contains_auth_failure_signal(output: &str) -> bool {
    [
        "not authenticated",
        "not logged in",
        "login required",
        "please login",
        "authentication required",
        "api key",
        "token expired",
        "invalid token",
        "credentials",
    ]
    .iter()
    .any(|signal| output.contains(signal))
}

fn contains_permission_denied_signal(output: &str) -> bool {
    output.contains("permission denied") || output.contains("access is denied")
}

fn default_health_check_args(kind: AiProviderKind) -> Vec<String> {
    match kind {
        AiProviderKind::Codex | AiProviderKind::Claude | AiProviderKind::Generic => {
            vec!["--version".to_owned()]
        }
    }
}

fn normalized_args(arguments: Vec<String>) -> Vec<String> {
    arguments
        .into_iter()
        .map(|argument| argument.trim().to_owned())
        .filter(|argument| !argument.is_empty())
        .collect()
}

fn normalized_optional_string(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_owned())
        }
    })
}

fn normalize_environment_allowlist(allowlist: Option<Vec<String>>) -> Option<Vec<String>> {
    allowlist.map(normalized_args)
}

fn generate_provider_id(kind: AiProviderKind, display_name: &str) -> String {
    let kind = match kind {
        AiProviderKind::Codex => "codex",
        AiProviderKind::Claude => "claude",
        AiProviderKind::Generic => "generic",
    };
    let slug = display_name
        .chars()
        .filter_map(|character| {
            if character.is_ascii_alphanumeric() {
                Some(character.to_ascii_lowercase())
            } else if matches!(character, ' ' | '-' | '_' | '.') {
                Some('-')
            } else {
                None
            }
        })
        .collect::<String>();
    let slug = slug.trim_matches('-');
    let slug = if slug.is_empty() { "provider" } else { slug };
    let slug = slug.chars().take(40).collect::<String>();
    format!(
        "{kind}-{slug}-{}-{}",
        Utc::now().timestamp_millis(),
        std::process::id()
    )
}

fn provider_not_found(provider_id: &str) -> AiProviderError {
    AiProviderError::new(
        AiProviderErrorCode::ProviderNotFound,
        "The requested AI provider is not configured.",
        true,
    )
    .with_field("providerId")
    .with_detail(provider_id.to_owned())
}

fn persistence_error(message: &'static str, path: &Path, error: io::Error) -> AiProviderError {
    AiProviderError::new(AiProviderErrorCode::PersistenceFailed, message, true)
        .with_field("settingsPath")
        .with_detail(format!("{}: {error}", path.display()))
}

fn default_timeout_seconds() -> u64 {
    DEFAULT_TIMEOUT_SECONDS
}

fn default_max_output_bytes() -> usize {
    DEFAULT_MAX_OUTPUT_BYTES
}

fn default_enabled() -> bool {
    true
}

impl AiProviderError {
    fn new(code: AiProviderErrorCode, message: impl Into<String>, recoverable: bool) -> Self {
        Self {
            code,
            message: message.into(),
            recoverable,
            field: None,
            detail: None,
        }
    }

    fn with_field(mut self, field: impl Into<String>) -> Self {
        self.field = Some(field.into());
        self
    }

    fn with_detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }
}

enum HealthRunError {
    Timeout,
    Io(io::Error),
}

#[cfg(test)]
mod tests {
    use super::*;

    fn provider_input(executable_path: String) -> AiProviderConfigInput {
        AiProviderConfigInput {
            id: Some("provider-1".to_owned()),
            display_name: "Local Codex".to_owned(),
            kind: AiProviderKind::Codex,
            executable_path,
            argument_template: vec!["exec".to_owned(), "-".to_owned()],
            health_check_args: vec!["--version".to_owned()],
            environment_allowlist: None,
            working_directory: None,
            timeout_seconds: 5,
            max_output_bytes: DEFAULT_MAX_OUTPUT_BYTES,
            enabled: true,
        }
    }

    #[test]
    fn serializes_provider_settings_round_trip() {
        let executable = current_test_executable();
        let provider = provider_input(executable)
            .into_config(Some(AiProviderHealthStatus {
                status: AiProviderHealthState::Ok,
                checked_at: "2026-05-10T00:00:00Z".to_owned(),
                message: "ok".to_owned(),
                detail: None,
                exit_code: Some(0),
                duration_ms: Some(7),
            }))
            .unwrap();
        let settings = AiProviderSettings {
            active_provider_id: Some(provider.id.clone()),
            providers: vec![provider],
        };

        let json = serde_json::to_string(&settings).unwrap();
        let decoded: AiProviderSettings = serde_json::from_str(&json).unwrap();

        assert_eq!(decoded, settings);
    }

    #[test]
    fn applies_default_values_from_input() {
        let mut input = provider_input(current_test_executable());
        input.health_check_args.clear();
        input.timeout_seconds = default_timeout_seconds();
        input.max_output_bytes = default_max_output_bytes();

        let provider = input.into_config(None).unwrap();

        assert_eq!(provider.health_check_args, vec!["--version"]);
        assert_eq!(provider.timeout_seconds, DEFAULT_TIMEOUT_SECONDS);
        assert_eq!(provider.max_output_bytes, DEFAULT_MAX_OUTPUT_BYTES);
        assert!(provider.enabled);
    }

    #[test]
    fn rejects_missing_executable_path() {
        let error = provider_input("".to_owned()).into_config(None).unwrap_err();

        assert_eq!(error.code, AiProviderErrorCode::MissingExecutable);
    }

    #[test]
    fn rejects_shell_command_strings_as_executable_paths() {
        let error = provider_input("codex --version".to_owned())
            .into_config(None)
            .unwrap_err();

        assert_eq!(error.code, AiProviderErrorCode::ShellCommandString);
    }

    #[test]
    fn rejects_invalid_timeout_and_output_limits() {
        let mut timeout_input = provider_input(current_test_executable());
        timeout_input.timeout_seconds = 0;
        let timeout_error = timeout_input.into_config(None).unwrap_err();
        assert_eq!(timeout_error.code, AiProviderErrorCode::InvalidTimeout);

        let mut output_input = provider_input(current_test_executable());
        output_input.max_output_bytes = 16;
        let output_error = output_input.into_config(None).unwrap_err();
        assert_eq!(output_error.code, AiProviderErrorCode::InvalidOutputLimit);
    }

    #[test]
    fn rejects_unsafe_working_directory() {
        let mut input = provider_input(current_test_executable());
        input.working_directory = Some(".. && rm -rf".to_owned());

        let error = input.into_config(None).unwrap_err();

        assert_eq!(error.code, AiProviderErrorCode::UnsafeWorkingDirectory);
    }

    #[test]
    fn persists_provider_settings_and_active_selection() {
        let temp = tempfile::tempdir().unwrap();
        let store = AiProviderStore::new(temp.path().join("settings/ai-providers.json"));
        let provider = provider_input(current_test_executable())
            .into_config(None)
            .unwrap();
        let settings = AiProviderSettings {
            active_provider_id: Some(provider.id.clone()),
            providers: vec![provider],
        };

        store.save(&settings).unwrap();
        let loaded = store.load().unwrap();

        assert_eq!(loaded, settings);
    }

    #[test]
    fn upsert_select_and_remove_provider_updates_active_id() {
        let provider = provider_input(current_test_executable())
            .into_config(None)
            .unwrap();
        let provider_id = provider.id.clone();
        let mut settings = AiProviderSettings::default();

        upsert_provider(&mut settings, provider).unwrap();
        assert_eq!(
            settings.active_provider_id.as_deref(),
            Some(provider_id.as_str())
        );

        select_provider(&mut settings, None).unwrap();
        assert_eq!(settings.active_provider_id, None);

        select_provider(&mut settings, Some(provider_id.clone())).unwrap();
        remove_provider(&mut settings, &provider_id).unwrap();
        assert_eq!(settings.active_provider_id, None);
        assert!(settings.providers.is_empty());
    }

    #[test]
    fn health_check_reports_missing_executable() {
        let provider = AiProviderConfig {
            id: "missing".to_owned(),
            display_name: "Missing".to_owned(),
            kind: AiProviderKind::Generic,
            executable_path: temp_missing_executable_path(),
            argument_template: Vec::new(),
            health_check_args: vec!["--version".to_owned()],
            environment_allowlist: None,
            working_directory: None,
            timeout_seconds: 1,
            max_output_bytes: DEFAULT_MAX_OUTPUT_BYTES,
            enabled: true,
            last_health_status: None,
        };

        let status = check_provider_health(&provider);

        assert_eq!(status.status, AiProviderHealthState::MissingExecutable);
    }

    #[test]
    fn health_check_maps_non_zero_exit() {
        let provider = mock_provider(&["exit", "7"], 5);

        let status = check_provider_health(&provider);

        assert_eq!(status.status, AiProviderHealthState::NonZeroExit);
        assert_eq!(status.exit_code, Some(7));
    }

    #[test]
    fn health_check_maps_auth_failure_output() {
        let provider = mock_provider(&["auth"], 5);

        let status = check_provider_health(&provider);

        assert_eq!(status.status, AiProviderHealthState::AuthRequired);
    }

    #[test]
    fn health_check_maps_success() {
        let provider = mock_provider(&["success"], 5);

        let status = check_provider_health(&provider);

        assert_eq!(status.status, AiProviderHealthState::Ok);
        assert!(status.message.contains("provider-ok"));
    }

    #[test]
    fn health_check_maps_timeout() {
        let provider = mock_provider(&["sleep"], 1);

        let status = check_provider_health(&provider);

        assert_eq!(status.status, AiProviderHealthState::Timeout);
    }

    fn current_test_executable() -> String {
        std::env::current_exe().unwrap().display().to_string()
    }

    fn temp_missing_executable_path() -> String {
        tempfile::tempdir()
            .unwrap()
            .path()
            .join(executable_name("missing-provider"))
            .display()
            .to_string()
    }

    #[cfg(windows)]
    fn mock_executable_path() -> String {
        std::env::var("COMSPEC").unwrap_or_else(|_| "C:\\Windows\\System32\\cmd.exe".to_owned())
    }

    #[cfg(unix)]
    fn mock_executable_path() -> String {
        "/bin/sh".to_owned()
    }

    #[cfg(windows)]
    fn mock_provider(args: &[&str], timeout_seconds: u64) -> AiProviderConfig {
        let command = match args.first().copied().unwrap_or("success") {
            "success" => "echo provider-ok",
            "auth" => "echo login required 1>&2 & exit /B 12",
            "sleep" => "ping -n 4 127.0.0.1 >nul",
            "exit" => {
                let code = args.get(1).copied().unwrap_or("1");
                return AiProviderConfig {
                    id: "mock".to_owned(),
                    display_name: "Mock".to_owned(),
                    kind: AiProviderKind::Generic,
                    executable_path: mock_executable_path(),
                    argument_template: Vec::new(),
                    health_check_args: vec!["/C".to_owned(), format!("exit /B {code}")],
                    environment_allowlist: None,
                    working_directory: None,
                    timeout_seconds,
                    max_output_bytes: DEFAULT_MAX_OUTPUT_BYTES,
                    enabled: true,
                    last_health_status: None,
                };
            }
            _ => "echo provider-ok",
        };

        AiProviderConfig {
            id: "mock".to_owned(),
            display_name: "Mock".to_owned(),
            kind: AiProviderKind::Generic,
            executable_path: mock_executable_path(),
            argument_template: Vec::new(),
            health_check_args: vec!["/C".to_owned(), command.to_owned()],
            environment_allowlist: None,
            working_directory: None,
            timeout_seconds,
            max_output_bytes: DEFAULT_MAX_OUTPUT_BYTES,
            enabled: true,
            last_health_status: None,
        }
    }

    #[cfg(unix)]
    fn mock_provider(args: &[&str], timeout_seconds: u64) -> AiProviderConfig {
        let script = match args.first().copied().unwrap_or("success") {
            "success" => "echo provider-ok",
            "auth" => "echo 'login required' >&2; exit 12",
            "sleep" => "sleep 3",
            "exit" => {
                let code = args.get(1).copied().unwrap_or("1");
                return AiProviderConfig {
                    id: "mock".to_owned(),
                    display_name: "Mock".to_owned(),
                    kind: AiProviderKind::Generic,
                    executable_path: mock_executable_path(),
                    argument_template: Vec::new(),
                    health_check_args: vec!["-c".to_owned(), format!("exit {code}")],
                    environment_allowlist: None,
                    working_directory: None,
                    timeout_seconds,
                    max_output_bytes: DEFAULT_MAX_OUTPUT_BYTES,
                    enabled: true,
                    last_health_status: None,
                };
            }
            _ => "echo provider-ok",
        };

        AiProviderConfig {
            id: "mock".to_owned(),
            display_name: "Mock".to_owned(),
            kind: AiProviderKind::Generic,
            executable_path: mock_executable_path(),
            argument_template: Vec::new(),
            health_check_args: vec!["-c".to_owned(), script.to_owned()],
            environment_allowlist: None,
            working_directory: None,
            timeout_seconds,
            max_output_bytes: DEFAULT_MAX_OUTPUT_BYTES,
            enabled: true,
            last_health_status: None,
        }
    }

    fn executable_name(stem: &str) -> String {
        if cfg!(windows) {
            format!("{stem}.exe")
        } else {
            stem.to_owned()
        }
    }
}
