use crate::models::{FileVersion, WorkspaceId, WorkspaceRelativePath};
use crate::time_utils::now_iso;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::VecDeque;
use std::fs;
use std::io::{self, Read, Write};
use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const DESKTOP_SESSION_FILE: &str = "desktop-session.json";
const BRIDGE_READ_TIMEOUT: Duration = Duration::from_millis(750);
const BRIDGE_WRITE_TIMEOUT: Duration = Duration::from_millis(750);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CliUiActionKind {
    OpenWindow,
    FocusExistingWindow,
    OpenReviewSurface,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CliUiAction {
    pub kind: CliUiActionKind,
    pub target: String,
    pub reason: String,
    pub handoff_token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DesktopBridgeDescriptor {
    pub schema_version: String,
    pub app_version: String,
    pub pid: u32,
    pub endpoint: String,
    pub auth_token: String,
    pub active_workspace_ids: Vec<WorkspaceId>,
    pub last_seen_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DesktopWorkspaceStatus {
    pub workspace_id: WorkspaceId,
    pub display_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DesktopOpenFileStatus {
    pub workspace_id: WorkspaceId,
    pub relative_path: WorkspaceRelativePath,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<FileVersion>,
    pub dirty: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DesktopDirtyDocument {
    pub workspace_id: WorkspaceId,
    pub relative_path: WorkspaceRelativePath,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_disk_version: Option<FileVersion>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DesktopPendingAiProposal {
    pub proposal_id: String,
    pub workspace_id: WorkspaceId,
    pub affected_files: Vec<WorkspaceRelativePath>,
    pub requires_review: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DesktopSessionStatus {
    pub running: bool,
    pub bridge_available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_workspace: Option<DesktopWorkspaceStatus>,
    pub open_files: Vec<DesktopOpenFileStatus>,
    pub dirty_documents: Vec<DesktopDirtyDocument>,
    pub pending_ai_proposals: Vec<DesktopPendingAiProposal>,
    pub can_handle_ui_action: bool,
    pub updated_at: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct DesktopSessionStatusUpdate {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_workspace: Option<DesktopWorkspaceStatus>,
    #[serde(default)]
    pub open_files: Vec<DesktopOpenFileStatus>,
    #[serde(default)]
    pub dirty_documents: Vec<DesktopDirtyDocument>,
    #[serde(default)]
    pub pending_ai_proposals: Vec<DesktopPendingAiProposal>,
    #[serde(default)]
    pub can_handle_ui_action: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DesktopBridgeProbe {
    NotRunning,
    Running(DesktopSessionStatus),
    Unavailable(DesktopBridgeError),
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DesktopBridgeErrorCode {
    DescriptorUnreadable,
    DescriptorInvalid,
    EndpointUnsupported,
    EndpointUnavailable,
    AuthenticationFailed,
    ProtocolError,
    RuntimeUnavailable,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DesktopBridgeError {
    pub code: DesktopBridgeErrorCode,
    pub message: String,
}

pub trait DesktopBridgeAdapter {
    fn session_status(&self) -> DesktopBridgeProbe;
    fn request_ui_action(&self, action: CliUiAction) -> Result<CliUiAction, DesktopBridgeError>;
}

#[derive(Debug, Clone)]
pub struct DesktopBridgeClient {
    descriptor_path: PathBuf,
}

#[derive(Debug, Clone)]
pub struct DesktopBridgeState {
    inner: Arc<Mutex<DesktopBridgeStateInner>>,
}

#[derive(Debug)]
struct DesktopBridgeStateInner {
    descriptor: Option<DesktopBridgeDescriptor>,
    descriptor_path: Option<PathBuf>,
    status: DesktopSessionStatus,
    pending_ui_actions: VecDeque<CliUiAction>,
    started: bool,
}

#[derive(Debug, Serialize, Deserialize)]
struct DesktopBridgeMessage {
    auth_token: String,
    request: DesktopBridgeRequest,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum DesktopBridgeRequest {
    Status,
    UiAction { action: CliUiAction },
}

#[derive(Debug, Serialize, Deserialize)]
struct DesktopBridgeResponse {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    status: Option<DesktopSessionStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ui_action: Option<CliUiAction>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<DesktopBridgeError>,
}

impl CliUiAction {
    pub fn new(
        kind: CliUiActionKind,
        target: impl Into<String>,
        reason: impl Into<String>,
    ) -> Self {
        let target = target.into();
        let reason = reason.into();
        let handoff_token = ui_handoff_token(&kind, &target, &reason);

        Self {
            kind,
            target,
            reason,
            handoff_token,
        }
    }
}

impl DesktopSessionStatus {
    pub fn not_running() -> Self {
        Self {
            running: false,
            bridge_available: false,
            app_version: None,
            pid: None,
            endpoint: None,
            active_workspace: None,
            open_files: Vec::new(),
            dirty_documents: Vec::new(),
            pending_ai_proposals: Vec::new(),
            can_handle_ui_action: false,
            updated_at: now_iso(),
        }
    }

    fn running_from_descriptor(descriptor: &DesktopBridgeDescriptor) -> Self {
        Self {
            running: true,
            bridge_available: true,
            app_version: Some(descriptor.app_version.clone()),
            pid: Some(descriptor.pid),
            endpoint: Some(descriptor.endpoint.clone()),
            active_workspace: None,
            open_files: Vec::new(),
            dirty_documents: Vec::new(),
            pending_ai_proposals: Vec::new(),
            can_handle_ui_action: true,
            updated_at: now_iso(),
        }
    }

    pub fn dirty_conflicts(
        &self,
        workspace_id: Option<&str>,
        relative_paths: &[WorkspaceRelativePath],
    ) -> Vec<DesktopDirtyDocument> {
        self.dirty_documents
            .iter()
            .filter(|document| workspace_matches(workspace_id, &document.workspace_id))
            .filter(|document| path_scope_matches(relative_paths, &document.relative_path))
            .cloned()
            .collect()
    }

    pub fn proposal_conflicts(
        &self,
        workspace_id: Option<&str>,
        relative_paths: &[WorkspaceRelativePath],
    ) -> Vec<DesktopPendingAiProposal> {
        self.pending_ai_proposals
            .iter()
            .filter(|proposal| proposal.requires_review)
            .filter(|proposal| workspace_matches(workspace_id, &proposal.workspace_id))
            .filter(|proposal| {
                relative_paths.is_empty()
                    || proposal
                        .affected_files
                        .iter()
                        .any(|path| path_scope_matches(relative_paths, path))
            })
            .cloned()
            .collect()
    }
}

impl Default for DesktopBridgeState {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(DesktopBridgeStateInner {
                descriptor: None,
                descriptor_path: None,
                status: DesktopSessionStatus::not_running(),
                pending_ui_actions: VecDeque::new(),
                started: false,
            })),
        }
    }
}

impl DesktopBridgeState {
    pub fn start(
        &self,
        app_data_dir: impl AsRef<Path>,
        app_version: impl Into<String>,
    ) -> Result<(), DesktopBridgeError> {
        {
            let inner = self.lock_inner()?;
            if inner.started {
                return Ok(());
            }
        }

        fs::create_dir_all(app_data_dir.as_ref()).map_err(|error| {
            bridge_io_error(
                DesktopBridgeErrorCode::DescriptorUnreadable,
                "The desktop session directory could not be created.",
                error,
            )
        })?;

        let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|error| {
            bridge_io_error(
                DesktopBridgeErrorCode::EndpointUnavailable,
                "The desktop bridge endpoint could not be opened.",
                error,
            )
        })?;
        let endpoint = format!(
            "tcp://{}",
            listener.local_addr().map_err(|error| {
                bridge_io_error(
                    DesktopBridgeErrorCode::EndpointUnavailable,
                    "The desktop bridge endpoint address is unavailable.",
                    error,
                )
            })?
        );
        let app_version = app_version.into();
        let auth_token = auth_token_for(app_data_dir.as_ref(), &endpoint);
        let descriptor_path = desktop_session_descriptor_path(app_data_dir);
        let descriptor = DesktopBridgeDescriptor {
            schema_version: "1.0.0".to_owned(),
            app_version: app_version.clone(),
            pid: std::process::id(),
            endpoint,
            auth_token,
            active_workspace_ids: Vec::new(),
            last_seen_at: now_iso(),
        };
        write_descriptor(&descriptor_path, &descriptor)?;

        {
            let mut inner = self.lock_inner()?;
            inner.status = DesktopSessionStatus::running_from_descriptor(&descriptor);
            inner.descriptor_path = Some(descriptor_path);
            inner.descriptor = Some(descriptor);
            inner.started = true;
        }

        let state = self.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                match stream {
                    Ok(stream) => handle_bridge_stream(&state, stream),
                    Err(_) => break,
                }
            }
        });

        Ok(())
    }

    pub fn update_status(
        &self,
        update: DesktopSessionStatusUpdate,
    ) -> Result<DesktopSessionStatus, DesktopBridgeError> {
        let mut inner = self.lock_inner()?;
        let descriptor_snapshot = inner.descriptor.clone();
        let descriptor_path = inner.descriptor_path.clone();
        let mut status = descriptor_snapshot
            .as_ref()
            .map(DesktopSessionStatus::running_from_descriptor)
            .unwrap_or_else(DesktopSessionStatus::not_running);

        status.active_workspace = update.active_workspace;
        status.open_files = update.open_files;
        status.dirty_documents = update.dirty_documents;
        status.pending_ai_proposals = update.pending_ai_proposals;
        status.can_handle_ui_action = update.can_handle_ui_action;
        status.updated_at = now_iso();

        inner.status = status.clone();

        if let (Some(mut descriptor), Some(path)) = (descriptor_snapshot, descriptor_path) {
            descriptor.active_workspace_ids = status
                .active_workspace
                .as_ref()
                .map(|workspace| vec![workspace.workspace_id.clone()])
                .unwrap_or_default();
            descriptor.last_seen_at = now_iso();
            write_descriptor(&path, &descriptor)?;
            inner.descriptor = Some(descriptor);
        }

        Ok(status)
    }

    pub fn status(&self) -> DesktopSessionStatus {
        self.lock_inner()
            .map(|inner| inner.status.clone())
            .unwrap_or_else(|_| DesktopSessionStatus::not_running())
    }

    pub fn drain_pending_ui_actions(&self) -> Vec<CliUiAction> {
        self.lock_inner()
            .map(|mut inner| inner.pending_ui_actions.drain(..).collect())
            .unwrap_or_default()
    }

    fn enqueue_ui_action(&self, action: CliUiAction) -> Result<CliUiAction, DesktopBridgeError> {
        let mut inner = self.lock_inner()?;
        if !inner.status.can_handle_ui_action {
            return Err(DesktopBridgeError::new(
                DesktopBridgeErrorCode::RuntimeUnavailable,
                "The desktop runtime cannot handle UI actions yet.",
            ));
        }

        inner.pending_ui_actions.push_back(action.clone());
        Ok(action)
    }

    fn authenticated_status(
        &self,
        auth_token: &str,
    ) -> Result<DesktopSessionStatus, DesktopBridgeError> {
        let inner = self.lock_inner()?;
        if inner
            .descriptor
            .as_ref()
            .map_or(true, |descriptor| descriptor.auth_token != auth_token)
        {
            return Err(DesktopBridgeError::new(
                DesktopBridgeErrorCode::AuthenticationFailed,
                "The desktop bridge authentication token was rejected.",
            ));
        }

        Ok(inner.status.clone())
    }

    fn lock_inner(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, DesktopBridgeStateInner>, DesktopBridgeError> {
        self.inner.lock().map_err(|_| {
            DesktopBridgeError::new(
                DesktopBridgeErrorCode::RuntimeUnavailable,
                "The desktop bridge state is unavailable.",
            )
        })
    }
}

impl DesktopBridgeClient {
    pub fn new(app_data_dir: impl AsRef<Path>) -> Self {
        Self {
            descriptor_path: desktop_session_descriptor_path(app_data_dir),
        }
    }

    pub fn descriptor_path(&self) -> &Path {
        &self.descriptor_path
    }

    fn read_descriptor(&self) -> Result<Option<DesktopBridgeDescriptor>, DesktopBridgeError> {
        match fs::read_to_string(&self.descriptor_path) {
            Ok(content) => serde_json::from_str(&content).map(Some).map_err(|error| {
                DesktopBridgeError::new(
                    DesktopBridgeErrorCode::DescriptorInvalid,
                    format!("The desktop session descriptor is invalid: {error}"),
                )
            }),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(bridge_io_error(
                DesktopBridgeErrorCode::DescriptorUnreadable,
                "The desktop session descriptor could not be read.",
                error,
            )),
        }
    }

    fn send_request(
        &self,
        descriptor: &DesktopBridgeDescriptor,
        request: DesktopBridgeRequest,
    ) -> Result<DesktopBridgeResponse, DesktopBridgeError> {
        let address = parse_tcp_endpoint(&descriptor.endpoint).ok_or_else(|| {
            DesktopBridgeError::new(
                DesktopBridgeErrorCode::EndpointUnsupported,
                "The desktop bridge endpoint protocol is not supported by this CLI.",
            )
        })?;

        let mut stream =
            TcpStream::connect_timeout(&address, BRIDGE_READ_TIMEOUT).map_err(|error| {
                bridge_io_error(
                    DesktopBridgeErrorCode::EndpointUnavailable,
                    "The desktop bridge endpoint is unavailable.",
                    error,
                )
            })?;
        stream.set_read_timeout(Some(BRIDGE_READ_TIMEOUT)).ok();
        stream.set_write_timeout(Some(BRIDGE_WRITE_TIMEOUT)).ok();

        let message = DesktopBridgeMessage {
            auth_token: descriptor.auth_token.clone(),
            request,
        };
        let bytes = serde_json::to_vec(&message).map_err(|error| {
            DesktopBridgeError::new(
                DesktopBridgeErrorCode::ProtocolError,
                format!("The desktop bridge request could not be encoded: {error}"),
            )
        })?;
        stream.write_all(&bytes).map_err(|error| {
            bridge_io_error(
                DesktopBridgeErrorCode::EndpointUnavailable,
                "The desktop bridge request could not be sent.",
                error,
            )
        })?;
        let _ = stream.shutdown(Shutdown::Write);

        let mut content = String::new();
        stream.read_to_string(&mut content).map_err(|error| {
            bridge_io_error(
                DesktopBridgeErrorCode::ProtocolError,
                "The desktop bridge response could not be read.",
                error,
            )
        })?;

        serde_json::from_str(&content).map_err(|error| {
            DesktopBridgeError::new(
                DesktopBridgeErrorCode::ProtocolError,
                format!("The desktop bridge response was invalid: {error}"),
            )
        })
    }
}

impl DesktopBridgeAdapter for DesktopBridgeClient {
    fn session_status(&self) -> DesktopBridgeProbe {
        let descriptor = match self.read_descriptor() {
            Ok(Some(descriptor)) => descriptor,
            Ok(None) => return DesktopBridgeProbe::NotRunning,
            Err(error) => return DesktopBridgeProbe::Unavailable(error),
        };

        match self.send_request(&descriptor, DesktopBridgeRequest::Status) {
            Ok(response) if response.ok => response
                .status
                .map(DesktopBridgeProbe::Running)
                .unwrap_or_else(|| {
                    DesktopBridgeProbe::Unavailable(DesktopBridgeError::new(
                        DesktopBridgeErrorCode::ProtocolError,
                        "The desktop bridge status response was empty.",
                    ))
                }),
            Ok(response) => DesktopBridgeProbe::Unavailable(response.error.unwrap_or_else(|| {
                DesktopBridgeError::new(
                    DesktopBridgeErrorCode::ProtocolError,
                    "The desktop bridge returned an unknown status error.",
                )
            })),
            Err(error) => DesktopBridgeProbe::Unavailable(error),
        }
    }

    fn request_ui_action(&self, action: CliUiAction) -> Result<CliUiAction, DesktopBridgeError> {
        let descriptor = self.read_descriptor()?.ok_or_else(|| {
            DesktopBridgeError::new(
                DesktopBridgeErrorCode::EndpointUnavailable,
                "No running desktop session is available for UI handoff.",
            )
        })?;

        let response = self.send_request(&descriptor, DesktopBridgeRequest::UiAction { action })?;
        if response.ok {
            response.ui_action.ok_or_else(|| {
                DesktopBridgeError::new(
                    DesktopBridgeErrorCode::ProtocolError,
                    "The desktop bridge UI action response was empty.",
                )
            })
        } else {
            Err(response.error.unwrap_or_else(|| {
                DesktopBridgeError::new(
                    DesktopBridgeErrorCode::ProtocolError,
                    "The desktop bridge returned an unknown UI action error.",
                )
            }))
        }
    }
}

impl DesktopBridgeError {
    pub fn new(code: DesktopBridgeErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

pub fn desktop_session_descriptor_path(app_data_dir: impl AsRef<Path>) -> PathBuf {
    app_data_dir.as_ref().join(DESKTOP_SESSION_FILE)
}

fn handle_bridge_stream(state: &DesktopBridgeState, mut stream: TcpStream) {
    let mut content = String::new();
    let response = match stream.read_to_string(&mut content) {
        Ok(_) => match serde_json::from_str::<DesktopBridgeMessage>(&content) {
            Ok(message) => handle_bridge_message(state, message),
            Err(error) => DesktopBridgeResponse::error(DesktopBridgeError::new(
                DesktopBridgeErrorCode::ProtocolError,
                format!("The desktop bridge request was invalid: {error}"),
            )),
        },
        Err(error) => DesktopBridgeResponse::error(bridge_io_error(
            DesktopBridgeErrorCode::ProtocolError,
            "The desktop bridge request could not be read.",
            error,
        )),
    };

    if let Ok(bytes) = serde_json::to_vec(&response) {
        let _ = stream.write_all(&bytes);
    }
}

fn handle_bridge_message(
    state: &DesktopBridgeState,
    message: DesktopBridgeMessage,
) -> DesktopBridgeResponse {
    match message.request {
        DesktopBridgeRequest::Status => match state.authenticated_status(&message.auth_token) {
            Ok(status) => DesktopBridgeResponse::status(status),
            Err(error) => DesktopBridgeResponse::error(error),
        },
        DesktopBridgeRequest::UiAction { action } => {
            match state.authenticated_status(&message.auth_token) {
                Ok(_) => match state.enqueue_ui_action(action) {
                    Ok(action) => DesktopBridgeResponse::ui_action(action),
                    Err(error) => DesktopBridgeResponse::error(error),
                },
                Err(error) => DesktopBridgeResponse::error(error),
            }
        }
    }
}

impl DesktopBridgeResponse {
    fn status(status: DesktopSessionStatus) -> Self {
        Self {
            ok: true,
            status: Some(status),
            ui_action: None,
            error: None,
        }
    }

    fn ui_action(action: CliUiAction) -> Self {
        Self {
            ok: true,
            status: None,
            ui_action: Some(action),
            error: None,
        }
    }

    fn error(error: DesktopBridgeError) -> Self {
        Self {
            ok: false,
            status: None,
            ui_action: None,
            error: Some(error),
        }
    }
}

fn parse_tcp_endpoint(endpoint: &str) -> Option<SocketAddr> {
    endpoint.strip_prefix("tcp://")?.parse().ok()
}

fn write_descriptor(
    path: &Path,
    descriptor: &DesktopBridgeDescriptor,
) -> Result<(), DesktopBridgeError> {
    let content = serde_json::to_vec_pretty(descriptor).map_err(|error| {
        DesktopBridgeError::new(
            DesktopBridgeErrorCode::DescriptorInvalid,
            format!("The desktop session descriptor could not be encoded: {error}"),
        )
    })?;
    fs::write(path, content).map_err(|error| {
        bridge_io_error(
            DesktopBridgeErrorCode::DescriptorUnreadable,
            "The desktop session descriptor could not be written.",
            error,
        )
    })
}

fn workspace_matches(requested_workspace_id: Option<&str>, candidate_workspace_id: &str) -> bool {
    requested_workspace_id.map_or(true, |workspace_id| workspace_id == candidate_workspace_id)
}

fn path_scope_matches(
    requested_paths: &[WorkspaceRelativePath],
    candidate_path: &WorkspaceRelativePath,
) -> bool {
    requested_paths.is_empty()
        || requested_paths
            .iter()
            .any(|path| path.as_str() == candidate_path.as_str())
}

fn ui_handoff_token(kind: &CliUiActionKind, target: &str, reason: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(format!("{kind:?}\n{target}\n{reason}").as_bytes());
    format!("ui:{}", &format!("{:x}", hasher.finalize())[..24])
}

fn auth_token_for(app_data_dir: &Path, endpoint: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(std::process::id().to_string().as_bytes());
    hasher.update(now_iso().as_bytes());
    hasher.update(app_data_dir.display().to_string().as_bytes());
    hasher.update(endpoint.as_bytes());
    format!("desktop:{}", &format!("{:x}", hasher.finalize())[..32])
}

fn bridge_io_error(
    code: DesktopBridgeErrorCode,
    message: &'static str,
    error: io::Error,
) -> DesktopBridgeError {
    DesktopBridgeError::new(code, format!("{message} {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace_status() -> DesktopWorkspaceStatus {
        DesktopWorkspaceStatus {
            workspace_id: "workspace-1".to_owned(),
            display_path: "/tmp/workspace".to_owned(),
        }
    }

    #[test]
    fn missing_descriptor_reports_not_running() {
        let temp = tempfile::tempdir().unwrap();
        let client = DesktopBridgeClient::new(temp.path());

        assert_eq!(client.session_status(), DesktopBridgeProbe::NotRunning);
    }

    #[test]
    fn loopback_bridge_reports_status_and_queues_ui_actions() {
        let temp = tempfile::tempdir().unwrap();
        let state = DesktopBridgeState::default();
        state.start(temp.path(), "0.1.0-test").unwrap();
        state
            .update_status(DesktopSessionStatusUpdate {
                active_workspace: Some(workspace_status()),
                can_handle_ui_action: true,
                ..DesktopSessionStatusUpdate::default()
            })
            .unwrap();
        let client = DesktopBridgeClient::new(temp.path());

        let status = match client.session_status() {
            DesktopBridgeProbe::Running(status) => status,
            other => panic!("expected running desktop status, got {other:?}"),
        };

        assert!(status.running);
        assert!(status.bridge_available);
        assert_eq!(
            status.active_workspace.as_ref().unwrap().workspace_id,
            "workspace-1"
        );

        let action = CliUiAction::new(
            CliUiActionKind::OpenReviewSurface,
            "workspace:workspace-1/file:notes.md",
            "Review dirty state before applying a change.",
        );
        let accepted = client.request_ui_action(action.clone()).unwrap();

        assert_eq!(accepted, action);
        assert_eq!(state.drain_pending_ui_actions(), vec![action]);
    }

    #[test]
    fn dirty_conflicts_match_workspace_and_requested_paths() {
        let status = DesktopSessionStatus {
            dirty_documents: vec![
                DesktopDirtyDocument {
                    workspace_id: "workspace-1".to_owned(),
                    relative_path: "notes.md".to_owned(),
                    last_disk_version: None,
                },
                DesktopDirtyDocument {
                    workspace_id: "workspace-2".to_owned(),
                    relative_path: "other.md".to_owned(),
                    last_disk_version: None,
                },
            ],
            ..DesktopSessionStatus::not_running()
        };

        assert_eq!(
            status
                .dirty_conflicts(Some("workspace-1"), &["notes.md".to_owned()])
                .len(),
            1
        );
        assert!(status
            .dirty_conflicts(Some("workspace-1"), &["missing.md".to_owned()])
            .is_empty());
        assert_eq!(status.dirty_conflicts(Some("workspace-1"), &[]).len(), 1);
    }
}
