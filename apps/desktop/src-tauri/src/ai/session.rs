use crate::ai::context::AiContextSnapshot;
use crate::ai::errors::{AiError, AiErrorCode};
use crate::models::{WorkspaceId, WorkspaceRelativePath};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

const DEFAULT_MAX_HISTORY_MESSAGES: usize = 12;
const DEFAULT_MAX_HISTORY_BYTES: usize = 12 * 1024;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AiMessageRole {
    User,
    Assistant,
    Error,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AiRunStatus {
    Queued,
    Running,
    Streaming,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiConversationLimits {
    #[serde(default = "default_max_history_messages")]
    pub max_history_messages: usize,
    #[serde(default = "default_max_history_bytes")]
    pub max_history_bytes: usize,
}

impl Default for AiConversationLimits {
    fn default() -> Self {
        Self {
            max_history_messages: default_max_history_messages(),
            max_history_bytes: default_max_history_bytes(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiConversationRequest {
    pub workspace_id: WorkspaceId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub document_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub document_path: Option<WorkspaceRelativePath>,
    pub prompt: String,
    pub context: AiContextSnapshot,
    #[serde(default)]
    pub limits: AiConversationLimits,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiMessage {
    pub id: String,
    pub session_id: String,
    pub run_id: String,
    pub role: AiMessageRole,
    pub content: String,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_code: Option<AiErrorCode>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiRun {
    pub id: String,
    pub session_id: String,
    pub provider_id: String,
    pub status: AiRunStatus,
    pub queued_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u128>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<AiError>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiSession {
    pub id: String,
    pub workspace_id: WorkspaceId,
    pub provider_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub document_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub document_path: Option<WorkspaceRelativePath>,
    pub messages: Vec<AiMessage>,
    pub created_at: String,
    pub updated_at: String,
    pub last_run_status: AiRunStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiRunDiagnostics {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stdout: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stderr: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
    pub timed_out: bool,
    pub cancelled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiResponse {
    pub run: AiRun,
    pub session: AiSession,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assistant_message: Option<AiMessage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<AiError>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diagnostics: Option<AiRunDiagnostics>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiRunEvent {
    pub run: AiRun,
    pub status: AiRunStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<AiError>,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct AiSessionKey {
    workspace_id: WorkspaceId,
    document_id: Option<String>,
    document_path: Option<WorkspaceRelativePath>,
    provider_id: String,
    session_id: String,
}

#[derive(Debug, Default)]
pub struct AiSessionStore {
    sessions: BTreeMap<AiSessionKey, AiSession>,
}

impl AiMessage {
    pub fn new(
        id: impl Into<String>,
        session_id: impl Into<String>,
        run_id: impl Into<String>,
        role: AiMessageRole,
        content: impl Into<String>,
        created_at: impl Into<String>,
    ) -> Self {
        Self {
            id: id.into(),
            session_id: session_id.into(),
            run_id: run_id.into(),
            role,
            content: content.into(),
            created_at: created_at.into(),
            context_label: None,
            error_code: None,
        }
    }

    pub fn with_context_label(mut self, context_label: impl Into<String>) -> Self {
        self.context_label = Some(context_label.into());
        self
    }

    pub fn with_error_code(mut self, error_code: AiErrorCode) -> Self {
        self.error_code = Some(error_code);
        self
    }
}

impl AiRun {
    pub fn queued(
        id: impl Into<String>,
        session_id: impl Into<String>,
        provider_id: impl Into<String>,
        queued_at: impl Into<String>,
    ) -> Self {
        Self {
            id: id.into(),
            session_id: session_id.into(),
            provider_id: provider_id.into(),
            status: AiRunStatus::Queued,
            queued_at: queued_at.into(),
            started_at: None,
            completed_at: None,
            duration_ms: None,
            error: None,
        }
    }

    pub fn transition(
        mut self,
        status: AiRunStatus,
        timestamp: impl Into<String>,
        duration_ms: Option<u128>,
        error: Option<AiError>,
    ) -> Self {
        let timestamp = timestamp.into();
        match status {
            AiRunStatus::Running | AiRunStatus::Streaming => {
                if self.started_at.is_none() {
                    self.started_at = Some(timestamp);
                }
            }
            AiRunStatus::Completed | AiRunStatus::Failed | AiRunStatus::Cancelled => {
                self.completed_at = Some(timestamp);
                self.duration_ms = duration_ms;
            }
            AiRunStatus::Queued => {}
        }
        self.status = status;
        self.error = error;
        self
    }
}

impl AiRunEvent {
    pub fn new(run: AiRun, error: Option<AiError>) -> Self {
        Self {
            status: run.status,
            run,
            error,
        }
    }
}

impl AiSessionKey {
    pub fn new(
        workspace_id: WorkspaceId,
        document_id: Option<String>,
        document_path: Option<WorkspaceRelativePath>,
        provider_id: String,
        session_id: String,
    ) -> Self {
        Self {
            workspace_id,
            document_id,
            document_path,
            provider_id,
            session_id,
        }
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }
}

impl AiSessionStore {
    pub fn ensure_session(&mut self, key: AiSessionKey, created_at: String) -> AiSession {
        self.sessions
            .entry(key.clone())
            .or_insert_with(|| AiSession {
                id: key.session_id.clone(),
                workspace_id: key.workspace_id.clone(),
                provider_id: key.provider_id.clone(),
                document_id: key.document_id.clone(),
                document_path: key.document_path.clone(),
                messages: Vec::new(),
                created_at: created_at.clone(),
                updated_at: created_at,
                last_run_status: AiRunStatus::Queued,
            })
            .clone()
    }

    pub fn append_message(
        &mut self,
        key: &AiSessionKey,
        message: AiMessage,
        last_run_status: AiRunStatus,
        updated_at: String,
    ) -> AiSession {
        let session = self
            .sessions
            .get_mut(key)
            .expect("session must be ensured before appending messages");
        session.messages.push(message);
        session.updated_at = updated_at;
        session.last_run_status = last_run_status;
        session.clone()
    }

    pub fn update_status(
        &mut self,
        key: &AiSessionKey,
        last_run_status: AiRunStatus,
        updated_at: String,
    ) -> AiSession {
        let session = self
            .sessions
            .get_mut(key)
            .expect("session must be ensured before updating status");
        session.updated_at = updated_at;
        session.last_run_status = last_run_status;
        session.clone()
    }

    pub fn bounded_history(
        &self,
        key: &AiSessionKey,
        limits: AiConversationLimits,
    ) -> Vec<AiMessage> {
        self.sessions
            .get(key)
            .map(|session| bounded_history(&session.messages, limits))
            .unwrap_or_default()
    }

    pub fn list(&self, workspace_id: Option<&str>) -> Vec<AiSession> {
        self.sessions
            .values()
            .filter(|session| {
                workspace_id
                    .map(|workspace_id| session.workspace_id == workspace_id)
                    .unwrap_or(true)
            })
            .cloned()
            .collect()
    }
}

pub fn session_key_from_request(
    request: &AiConversationRequest,
    provider_id: &str,
    session_id: String,
) -> AiSessionKey {
    AiSessionKey::new(
        request.workspace_id.clone(),
        request.document_id.clone(),
        request.document_path.clone(),
        provider_id.to_owned(),
        session_id,
    )
}

pub fn bounded_history(messages: &[AiMessage], limits: AiConversationLimits) -> Vec<AiMessage> {
    if limits.max_history_messages == 0 || limits.max_history_bytes == 0 {
        return Vec::new();
    }

    let mut selected = Vec::new();
    let mut used_bytes = 0usize;

    for message in messages.iter().rev() {
        if selected.len() >= limits.max_history_messages {
            break;
        }

        let message_bytes = message.content.as_bytes().len();
        if used_bytes + message_bytes <= limits.max_history_bytes {
            used_bytes += message_bytes;
            selected.push(message.clone());
            continue;
        }

        if selected.is_empty() {
            let remaining = limits.max_history_bytes.saturating_sub(12);
            if remaining > 0 {
                let mut truncated = message.clone();
                truncated.content = format!(
                    "[truncated]\n{}",
                    take_last_utf8_bytes(&message.content, remaining)
                );
                selected.push(truncated);
            }
        }
        break;
    }

    selected.reverse();
    selected
}

fn take_last_utf8_bytes(value: &str, max_bytes: usize) -> &str {
    if value.as_bytes().len() <= max_bytes {
        return value;
    }

    let mut start = value.len() - max_bytes;
    while !value.is_char_boundary(start) {
        start += 1;
    }
    &value[start..]
}

fn default_max_history_messages() -> usize {
    DEFAULT_MAX_HISTORY_MESSAGES
}

fn default_max_history_bytes() -> usize {
    DEFAULT_MAX_HISTORY_BYTES
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn append_preserves_message_order_and_status() {
        let mut store = AiSessionStore::default();
        let key = AiSessionKey::new(
            "workspace".to_owned(),
            Some("doc".to_owned()),
            Some("notes.md".to_owned()),
            "provider".to_owned(),
            "session".to_owned(),
        );
        store.ensure_session(key.clone(), "2026-05-10T00:00:00Z".to_owned());

        store.append_message(
            &key,
            AiMessage::new("m1", "session", "run-1", AiMessageRole::User, "first", "t1"),
            AiRunStatus::Running,
            "t1".to_owned(),
        );
        let session = store.append_message(
            &key,
            AiMessage::new(
                "m2",
                "session",
                "run-1",
                AiMessageRole::Assistant,
                "second",
                "t2",
            ),
            AiRunStatus::Completed,
            "t2".to_owned(),
        );

        assert_eq!(session.last_run_status, AiRunStatus::Completed);
        assert_eq!(session.messages[0].content, "first");
        assert_eq!(session.messages[1].content, "second");
    }

    #[test]
    fn history_trimming_keeps_newest_messages_within_bounds() {
        let messages = vec![
            AiMessage::new("m1", "s", "r1", AiMessageRole::User, "old", "t1"),
            AiMessage::new("m2", "s", "r1", AiMessageRole::Assistant, "middle", "t2"),
            AiMessage::new("m3", "s", "r2", AiMessageRole::User, "new", "t3"),
        ];

        let history = bounded_history(
            &messages,
            AiConversationLimits {
                max_history_messages: 2,
                max_history_bytes: 64,
            },
        );

        assert_eq!(
            history
                .iter()
                .map(|message| message.content.as_str())
                .collect::<Vec<_>>(),
            vec!["middle", "new"]
        );
    }

    #[test]
    fn history_trimming_caps_oversized_latest_message() {
        let messages = vec![AiMessage::new(
            "m1",
            "s",
            "r1",
            AiMessageRole::Assistant,
            "abcdefghijklmnopqrstuvwxyz",
            "t1",
        )];

        let history = bounded_history(
            &messages,
            AiConversationLimits {
                max_history_messages: 4,
                max_history_bytes: 20,
            },
        );

        assert_eq!(history.len(), 1);
        assert!(history[0].content.starts_with("[truncated]"));
        assert!(history[0].content.as_bytes().len() <= 20);
    }
}
