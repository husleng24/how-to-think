use crate::ai::errors::{AiError, AiErrorCode};
use crate::ai::process::{
    run_provider_process, ProviderProcessError, ProviderProcessOutput, ProviderProcessRequest,
};
use crate::ai::providers::{
    provider_store, validate_provider_config, AiProviderConfig, AiProviderError,
    AiProviderErrorCode, AiProviderSettings,
};
use crate::ai::session::{
    session_key_from_request, AiConversationRequest, AiMessage, AiMessageRole, AiResponse, AiRun,
    AiRunDiagnostics, AiRunEvent, AiRunStatus, AiSession, AiSessionKey, AiSessionStore,
};
use chrono::Utc;
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::{AppHandle, Emitter, State};

pub const AI_RUN_STATUS_EVENT: &str = "ai-run-status";

#[derive(Debug)]
pub struct AiRuntimeState {
    sessions: Mutex<AiSessionStore>,
    active_runs: Mutex<BTreeMap<String, ActiveRun>>,
    sequence: AtomicU64,
}

#[derive(Debug, Clone)]
struct ActiveRun {
    run: AiRun,
    cancel_flag: Arc<AtomicBool>,
}

impl Default for AiRuntimeState {
    fn default() -> Self {
        Self {
            sessions: Mutex::new(AiSessionStore::default()),
            active_runs: Mutex::new(BTreeMap::new()),
            sequence: AtomicU64::new(1),
        }
    }
}

#[tauri::command]
pub fn send_ai_conversation_message(
    app: AppHandle,
    state: State<'_, AiRuntimeState>,
    request: AiConversationRequest,
) -> Result<AiResponse, AiError> {
    let provider = load_provider_for_request(&app, request.provider_id.as_deref())?;
    run_ai_conversation(state.inner(), provider, request, |event| {
        let _ = app.emit(AI_RUN_STATUS_EVENT, event);
    })
}

#[tauri::command]
pub fn cancel_ai_run(state: State<'_, AiRuntimeState>, run_id: String) -> Result<AiRun, AiError> {
    state.inner().cancel_run(&run_id)
}

#[tauri::command]
pub fn list_ai_sessions(
    state: State<'_, AiRuntimeState>,
    workspace_id: Option<String>,
) -> Vec<AiSession> {
    state.inner().list_sessions(workspace_id.as_deref())
}

pub fn run_ai_conversation(
    state: &AiRuntimeState,
    provider: AiProviderConfig,
    request: AiConversationRequest,
    mut emit_event: impl FnMut(AiRunEvent),
) -> Result<AiResponse, AiError> {
    validate_conversation_request(&request)?;
    validate_provider_config(&provider).map_err(map_provider_config_error)?;
    if !provider.enabled {
        return Err(AiError::new(
            AiErrorCode::ProviderDisabled,
            "The selected AI provider is disabled.",
            true,
            "Enable this provider or choose a different active provider.",
        )
        .with_provider_id(provider.id));
    }

    let session_id = normalized_optional_string(request.session_id.clone())
        .unwrap_or_else(|| state.next_id("session"));
    let key = session_key_from_request(&request, &provider.id, session_id.clone());
    let run_id = state.next_id("run");
    let queued_at = now();
    let mut run = AiRun::queued(
        run_id.clone(),
        session_id.clone(),
        provider.id.clone(),
        queued_at.clone(),
    );
    let prior_history = {
        let mut sessions = state.sessions.lock().expect("AI session mutex poisoned");
        sessions.ensure_session(key.clone(), queued_at.clone());
        let history = sessions.bounded_history(&key, request.limits);
        let message = AiMessage::new(
            state.next_id("message"),
            session_id.clone(),
            run_id.clone(),
            AiMessageRole::User,
            request.prompt.clone(),
            queued_at.clone(),
        )
        .with_context_label(request.context.display_label.clone());
        sessions.append_message(&key, message, AiRunStatus::Queued, queued_at.clone());
        history
    };

    let cancel_flag = Arc::new(AtomicBool::new(false));
    state.insert_active_run(run.clone(), cancel_flag.clone());
    emit_event(AiRunEvent::new(run.clone(), None));

    let started_at = now();
    run = run.transition(AiRunStatus::Running, started_at, None, None);
    state.update_active_run(run.clone());
    state.update_session_status(&key, AiRunStatus::Running);
    emit_event(AiRunEvent::new(run.clone(), None));

    let envelope = build_prompt_envelope(&request, &prior_history);
    let started = Instant::now();
    let process_result = run_provider_process(ProviderProcessRequest {
        provider: &provider,
        args: &provider.argument_template,
        stdin: Some(envelope.into_bytes()),
        cancel_flag: Some(cancel_flag),
    });
    let elapsed_ms = started.elapsed().as_millis();
    state.remove_active_run(&run_id);

    match process_result {
        Ok(output) => finalize_process_output(
            state,
            &key,
            run,
            provider,
            output,
            elapsed_ms,
            &mut emit_event,
        ),
        Err(error) => finalize_process_start_error(
            state,
            &key,
            run,
            provider.id,
            error,
            elapsed_ms,
            &mut emit_event,
        ),
    }
}

pub fn build_prompt_envelope(
    request: &AiConversationRequest,
    prior_history: &[AiMessage],
) -> String {
    let mut envelope = String::new();
    envelope.push_str("How to Think local AI conversation\n\n");
    envelope.push_str("Instructions:\n");
    envelope.push_str("- Answer the user's latest question using only the supplied context snapshot and prior conversation.\n");
    envelope.push_str(
        "- If the answer is not supported by the supplied context, say what is missing.\n",
    );
    envelope.push_str(
        "- Do not apply edits, save Markdown files, or read files outside this prompt.\n\n",
    );

    envelope.push_str("Context snapshot:\n");
    envelope.push_str(&format!("Workspace id: {}\n", request.context.workspace_id));
    envelope.push_str(&format!("Scope: {:?}\n", request.context.scope));
    envelope.push_str(&format!("Label: {}\n", request.context.display_label));
    if let Some(document_id) = &request.context.document_id {
        envelope.push_str(&format!("Document id: {document_id}\n"));
    }
    if let Some(document_path) = &request.context.document_path {
        envelope.push_str(&format!("Document path: {document_path}\n"));
    }
    if let Some(document_revision) = &request.context.document_revision {
        envelope.push_str(&format!("Document revision: {document_revision}\n"));
    }
    envelope.push_str(&format!(
        "Context bytes: {} token estimate: {} truncated: {}\n",
        request.context.byte_estimate, request.context.token_estimate, request.context.truncated
    ));
    if !request.context.warnings.is_empty() {
        envelope.push_str("Warnings:\n");
        for warning in &request.context.warnings {
            envelope.push_str(&format!("- {:?}: {}\n", warning.code, warning.message));
        }
    }
    envelope.push('\n');

    for item in &request.context.items {
        envelope.push_str(&format!(
            "----- Context item: {} ({:?}) -----\n",
            item.label, item.kind
        ));
        if let Some(relative_path) = &item.relative_path {
            envelope.push_str(&format!("Relative path: {relative_path}\n"));
        }
        if !item.node_ids.is_empty() {
            envelope.push_str(&format!("Node ids: {}\n", item.node_ids.join(", ")));
        }
        envelope.push_str(&item.content);
        if !item.content.ends_with('\n') {
            envelope.push('\n');
        }
        envelope.push('\n');
    }

    envelope.push_str("Prior conversation:\n");
    if prior_history.is_empty() {
        envelope.push_str("(none)\n");
    } else {
        for message in prior_history {
            envelope.push_str(&format!(
                "{}: {}\n",
                message_role_label(message.role),
                message.content
            ));
        }
    }

    envelope.push_str("\nLatest user prompt:\n");
    envelope.push_str(&request.prompt);
    if !request.prompt.ends_with('\n') {
        envelope.push('\n');
    }
    envelope
}

impl AiRuntimeState {
    fn next_id(&self, prefix: &str) -> String {
        let sequence = self.sequence.fetch_add(1, Ordering::Relaxed);
        format!("{prefix}-{}-{sequence}", Utc::now().timestamp_millis())
    }

    fn insert_active_run(&self, run: AiRun, cancel_flag: Arc<AtomicBool>) {
        self.active_runs
            .lock()
            .expect("AI active-run mutex poisoned")
            .insert(run.id.clone(), ActiveRun { run, cancel_flag });
    }

    fn update_active_run(&self, run: AiRun) {
        if let Some(active_run) = self
            .active_runs
            .lock()
            .expect("AI active-run mutex poisoned")
            .get_mut(&run.id)
        {
            active_run.run = run;
        }
    }

    fn remove_active_run(&self, run_id: &str) {
        self.active_runs
            .lock()
            .expect("AI active-run mutex poisoned")
            .remove(run_id);
    }

    fn update_session_status(&self, key: &AiSessionKey, status: AiRunStatus) -> AiSession {
        self.sessions
            .lock()
            .expect("AI session mutex poisoned")
            .update_status(key, status, now())
    }

    fn append_session_message(
        &self,
        key: &AiSessionKey,
        message: AiMessage,
        status: AiRunStatus,
    ) -> AiSession {
        self.sessions
            .lock()
            .expect("AI session mutex poisoned")
            .append_message(key, message, status, now())
    }

    fn cancel_run(&self, run_id: &str) -> Result<AiRun, AiError> {
        let mut active_runs = self
            .active_runs
            .lock()
            .expect("AI active-run mutex poisoned");
        let active_run = active_runs.get_mut(run_id).ok_or_else(|| {
            AiError::new(
                AiErrorCode::InvalidRequest,
                "No active AI run matched the requested run id.",
                true,
                "Refresh the conversation state and try again if the run is still visible.",
            )
            .with_run_id(run_id.to_owned())
        })?;
        active_run.cancel_flag.store(true, Ordering::SeqCst);
        active_run.run = active_run.run.clone().transition(
            AiRunStatus::Cancelled,
            now(),
            None,
            Some(cancelled_error(run_id, &active_run.run.provider_id)),
        );
        Ok(active_run.run.clone())
    }

    fn list_sessions(&self, workspace_id: Option<&str>) -> Vec<AiSession> {
        self.sessions
            .lock()
            .expect("AI session mutex poisoned")
            .list(workspace_id)
    }
}

fn load_provider_for_request(
    app: &AppHandle,
    requested_provider_id: Option<&str>,
) -> Result<AiProviderConfig, AiError> {
    let settings = provider_store(app)
        .map_err(map_provider_store_error)?
        .load()
        .map_err(|error| {
            AiError::new(
                AiErrorCode::RuntimeUnavailable,
                "AI provider settings could not be loaded.",
                true,
                "Open provider settings, verify the saved providers, and try again.",
            )
            .with_detail(error.message)
        })?;

    resolve_provider_config(&settings, requested_provider_id)
}

fn resolve_provider_config(
    settings: &AiProviderSettings,
    requested_provider_id: Option<&str>,
) -> Result<AiProviderConfig, AiError> {
    let provider_id = requested_provider_id
        .and_then(|id| {
            let trimmed = id.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed)
            }
        })
        .or(settings.active_provider_id.as_deref())
        .ok_or_else(|| {
            AiError::new(
                AiErrorCode::ProviderNotConfigured,
                "No active AI provider is configured.",
                true,
                "Add a local provider or select an existing provider before starting a conversation.",
            )
        })?;

    let provider = settings
        .providers
        .iter()
        .find(|provider| provider.id == provider_id)
        .cloned()
        .ok_or_else(|| {
            AiError::new(
                AiErrorCode::ProviderNotConfigured,
                "The requested AI provider is not configured.",
                true,
                "Select an available provider and try again.",
            )
            .with_provider_id(provider_id.to_owned())
        })?;

    if !provider.enabled {
        return Err(AiError::new(
            AiErrorCode::ProviderDisabled,
            "The selected AI provider is disabled.",
            true,
            "Enable this provider or choose a different active provider.",
        )
        .with_provider_id(provider.id));
    }

    Ok(provider)
}

fn validate_conversation_request(request: &AiConversationRequest) -> Result<(), AiError> {
    if request.workspace_id.trim().is_empty() {
        return Err(AiError::new(
            AiErrorCode::InvalidRequest,
            "AI conversation requests require a workspace id.",
            true,
            "Open a workspace and try again.",
        ));
    }

    if request.prompt.trim().is_empty() {
        return Err(AiError::new(
            AiErrorCode::InvalidRequest,
            "AI conversation requests require a prompt.",
            true,
            "Type a question or instruction before starting the run.",
        ));
    }

    if request.context.workspace_id != request.workspace_id {
        return Err(AiError::new(
            AiErrorCode::InvalidRequest,
            "The supplied AI context snapshot belongs to a different workspace.",
            true,
            "Refresh the context snapshot for the current workspace and try again.",
        ));
    }

    Ok(())
}

fn finalize_process_output(
    state: &AiRuntimeState,
    key: &AiSessionKey,
    run: AiRun,
    provider: AiProviderConfig,
    output: ProviderProcessOutput,
    elapsed_ms: u128,
    emit_event: &mut impl FnMut(AiRunEvent),
) -> Result<AiResponse, AiError> {
    if output.cancelled {
        let error = cancelled_error(&run.id, &provider.id);
        return finalize_failed_run(
            state,
            key,
            run,
            provider.id,
            AiRunStatus::Cancelled,
            error,
            Some(diagnostics_from_output(&output)),
            elapsed_ms,
            emit_event,
        );
    }

    if output.timed_out {
        let error = AiError::new(
            AiErrorCode::ProviderTimedOut,
            format!(
                "The AI provider did not finish within {} seconds.",
                provider.timeout_seconds
            ),
            true,
            "Increase the provider timeout or try a smaller context snapshot.",
        )
        .with_provider_id(provider.id.clone())
        .with_run_id(run.id.clone());
        return finalize_failed_run(
            state,
            key,
            run,
            provider.id,
            AiRunStatus::Failed,
            error,
            Some(diagnostics_from_output(&output)),
            elapsed_ms,
            emit_event,
        );
    }

    if !output.success {
        let error = AiError::new(
            AiErrorCode::ProviderNonZeroExit,
            "The AI provider exited with a non-zero status.",
            true,
            "Review the provider command, authentication, and local provider output, then try again.",
        )
        .with_provider_id(provider.id.clone())
        .with_run_id(run.id.clone())
        .with_exit_code(output.exit_code);
        return finalize_failed_run(
            state,
            key,
            run,
            provider.id,
            AiRunStatus::Failed,
            error,
            Some(diagnostics_from_output(&output)),
            elapsed_ms,
            emit_event,
        );
    }

    if output.stdout_truncated {
        let error = AiError::new(
            AiErrorCode::ProviderOutputTooLarge,
            "The AI provider response exceeded the configured output limit.",
            true,
            "Increase the provider output limit or ask for a shorter response.",
        )
        .with_provider_id(provider.id.clone())
        .with_run_id(run.id.clone());
        return finalize_failed_run(
            state,
            key,
            run,
            provider.id,
            AiRunStatus::Failed,
            error,
            Some(diagnostics_from_output(&output)),
            elapsed_ms,
            emit_event,
        );
    }

    let assistant_content = match parse_provider_response(&output.stdout) {
        Ok(content) => content,
        Err(error) => {
            let error = error
                .with_provider_id(provider.id.clone())
                .with_run_id(run.id.clone());
            return finalize_failed_run(
                state,
                key,
                run,
                provider.id,
                AiRunStatus::Failed,
                error,
                Some(diagnostics_from_output(&output)),
                elapsed_ms,
                emit_event,
            );
        }
    };

    let completed_at = now();
    let final_run = run.transition(
        AiRunStatus::Completed,
        completed_at.clone(),
        Some(elapsed_ms),
        None,
    );
    let assistant_message = AiMessage::new(
        state.next_id("message"),
        key.session_id().to_owned(),
        final_run.id.clone(),
        AiMessageRole::Assistant,
        assistant_content,
        completed_at,
    );
    let session =
        state.append_session_message(key, assistant_message.clone(), AiRunStatus::Completed);
    emit_event(AiRunEvent::new(final_run.clone(), None));

    Ok(AiResponse {
        run: final_run,
        session,
        assistant_message: Some(assistant_message),
        error: None,
        diagnostics: diagnostics_if_useful(&output),
    })
}

fn finalize_process_start_error(
    state: &AiRuntimeState,
    key: &AiSessionKey,
    run: AiRun,
    provider_id: String,
    error: ProviderProcessError,
    elapsed_ms: u128,
    emit_event: &mut impl FnMut(AiRunEvent),
) -> Result<AiResponse, AiError> {
    let error = match error {
        ProviderProcessError::Spawn(error) => AiError::new(
            AiErrorCode::ProviderUnavailable,
            "The AI provider process could not be started.",
            true,
            "Verify the provider executable path and permissions, then try again.",
        )
        .with_detail(error.to_string()),
        ProviderProcessError::Stdin(error) => AiError::new(
            AiErrorCode::ProviderUnavailable,
            "The AI provider did not accept the prompt input.",
            true,
            "Verify the provider command reads from standard input or adjust its arguments.",
        )
        .with_detail(error.to_string()),
        ProviderProcessError::Wait(error) => AiError::new(
            AiErrorCode::ProviderUnavailable,
            "The AI provider process result could not be collected.",
            true,
            "Retry the run. If it keeps failing, choose a different provider command.",
        )
        .with_detail(error.to_string()),
    }
    .with_provider_id(provider_id.clone())
    .with_run_id(run.id.clone());

    finalize_failed_run(
        state,
        key,
        run,
        provider_id,
        AiRunStatus::Failed,
        error,
        None,
        elapsed_ms,
        emit_event,
    )
}

#[allow(clippy::too_many_arguments)]
fn finalize_failed_run(
    state: &AiRuntimeState,
    key: &AiSessionKey,
    run: AiRun,
    provider_id: String,
    status: AiRunStatus,
    error: AiError,
    diagnostics: Option<AiRunDiagnostics>,
    elapsed_ms: u128,
    emit_event: &mut impl FnMut(AiRunEvent),
) -> Result<AiResponse, AiError> {
    let completed_at = now();
    let final_run = run.transition(
        status,
        completed_at.clone(),
        Some(elapsed_ms),
        Some(error.clone()),
    );
    let message = AiMessage::new(
        state.next_id("message"),
        key.session_id().to_owned(),
        final_run.id.clone(),
        AiMessageRole::Error,
        error.message.clone(),
        completed_at,
    )
    .with_error_code(error.code);
    let session = state.append_session_message(key, message, status);
    let event = AiRunEvent::new(final_run.clone(), Some(error.clone()));
    emit_event(event);

    Ok(AiResponse {
        run: final_run,
        session,
        assistant_message: None,
        error: Some(error.with_provider_id(provider_id)),
        diagnostics,
    })
}

fn parse_provider_response(stdout: &str) -> Result<String, AiError> {
    let output = stdout.trim();
    if output.is_empty() {
        return Err(AiError::new(
            AiErrorCode::ProviderOutputMalformed,
            "The AI provider returned an empty response.",
            true,
            "Check the provider command and make sure it writes an assistant response to stdout.",
        ));
    }

    if output.starts_with('{') || output.starts_with('[') {
        let value: Value = serde_json::from_str(output).map_err(|_| {
            AiError::new(
                AiErrorCode::ProviderOutputMalformed,
                "The AI provider returned malformed JSON.",
                true,
                "Return plain text, or JSON with a string `message` or `content` field.",
            )
        })?;

        if let Some(content) = value
            .get("message")
            .or_else(|| value.get("content"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|content| !content.is_empty())
        {
            return Ok(content.to_owned());
        }

        return Err(AiError::new(
            AiErrorCode::ProviderOutputMalformed,
            "The AI provider JSON response did not include assistant content.",
            true,
            "Return plain text, or JSON with a string `message` or `content` field.",
        ));
    }

    Ok(output.to_owned())
}

fn diagnostics_from_output(output: &ProviderProcessOutput) -> AiRunDiagnostics {
    AiRunDiagnostics {
        stdout: non_empty_trimmed(&output.stdout),
        stderr: non_empty_trimmed(&output.stderr),
        exit_code: output.exit_code,
        stdout_truncated: output.stdout_truncated,
        stderr_truncated: output.stderr_truncated,
        timed_out: output.timed_out,
        cancelled: output.cancelled,
    }
}

fn diagnostics_if_useful(output: &ProviderProcessOutput) -> Option<AiRunDiagnostics> {
    if output.stderr.trim().is_empty() && !output.stderr_truncated && !output.stdout_truncated {
        None
    } else {
        Some(diagnostics_from_output(output))
    }
}

fn non_empty_trimmed(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() {
        None
    } else {
        Some(value.to_owned())
    }
}

fn message_role_label(role: AiMessageRole) -> &'static str {
    match role {
        AiMessageRole::User => "User",
        AiMessageRole::Assistant => "Assistant",
        AiMessageRole::Error => "Error",
    }
}

fn cancelled_error(run_id: &str, provider_id: &str) -> AiError {
    AiError::new(
        AiErrorCode::ProviderCancelled,
        "The AI provider run was cancelled.",
        true,
        "Start a new run when you are ready.",
    )
    .with_provider_id(provider_id.to_owned())
    .with_run_id(run_id.to_owned())
}

fn map_provider_store_error(error: AiProviderError) -> AiError {
    AiError::new(
        AiErrorCode::RuntimeUnavailable,
        "AI provider settings are unavailable.",
        true,
        "Open provider settings and try again.",
    )
    .with_detail(error.message)
}

fn map_provider_config_error(error: AiProviderError) -> AiError {
    let code = match error.code {
        AiProviderErrorCode::ProviderDisabled => AiErrorCode::ProviderDisabled,
        _ => AiErrorCode::ProviderConfigInvalid,
    };
    AiError::new(
        code,
        error.message,
        error.recoverable,
        "Fix the selected provider settings and try again.",
    )
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

fn now() -> String {
    Utc::now().to_rfc3339()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::context::{AiContextItem, AiContextItemKind, AiContextScope, AiContextSnapshot};
    use crate::ai::providers::{AiProviderHealthStatus, AiProviderKind};
    use std::fs;
    use std::path::Path;
    use std::sync::Mutex;
    use std::thread;
    use std::time::Duration;

    #[test]
    fn prompt_envelope_contains_context_history_and_latest_prompt() {
        let request = request("workspace", None, "What follows?");
        let history = vec![
            AiMessage::new("m1", "s", "r1", AiMessageRole::User, "First question", "t1"),
            AiMessage::new(
                "m2",
                "s",
                "r1",
                AiMessageRole::Assistant,
                "First answer",
                "t2",
            ),
        ];

        let envelope = build_prompt_envelope(&request, &history);

        assert!(envelope.contains("Context item: Current file"));
        assert!(envelope.contains("important context"));
        assert!(envelope.contains("User: First question"));
        assert!(envelope.contains("Assistant: First answer"));
        assert!(envelope.contains("Latest user prompt:\nWhat follows?"));
    }

    #[test]
    fn status_events_transition_through_completed() {
        let state = AiRuntimeState::default();
        let provider = fixed_output_provider(r#"{"message":"assistant response"}"#, 5);
        let request = request("workspace", Some("session"), "Hello");
        let events = Mutex::new(Vec::new());

        let response = run_ai_conversation(&state, provider, request, |event| {
            events.lock().unwrap().push(event.status);
        })
        .unwrap();

        assert_eq!(response.run.status, AiRunStatus::Completed);
        assert_eq!(
            events.lock().unwrap().as_slice(),
            [
                AiRunStatus::Queued,
                AiRunStatus::Running,
                AiRunStatus::Completed
            ]
        );
    }

    #[test]
    fn mock_provider_receives_prompt_context_on_stdin() {
        let state = AiRuntimeState::default();
        let provider = stdin_echo_provider(5);
        let request = request("workspace", Some("session"), "Summarize this");

        let response = run_ai_conversation(&state, provider, request, |_| {}).unwrap();
        let content = &response.assistant_message.unwrap().content;

        assert!(content.contains("Summarize this"));
        assert!(content.contains("important context"));
    }

    #[test]
    fn follow_up_prompt_includes_bounded_prior_history() {
        let state = AiRuntimeState::default();
        let provider = fixed_output_provider("First answer", 5);
        let first = request("workspace", Some("session"), "First?");
        run_ai_conversation(&state, provider, first, |_| {}).unwrap();

        let provider = stdin_echo_provider(5);
        let second = request("workspace", Some("session"), "Second?");
        let response = run_ai_conversation(&state, provider, second, |_| {}).unwrap();
        let content = response.assistant_message.unwrap().content;

        assert!(content.contains("Assistant: First answer"));
        assert!(content.contains("Latest user prompt:\nSecond?"));
    }

    #[test]
    fn non_zero_exit_captures_diagnostics_and_appends_error_message() {
        let state = AiRuntimeState::default();
        let provider = non_zero_provider(7, "provider stderr", 5);
        let request = request("workspace", Some("session"), "Hello");

        let response = run_ai_conversation(&state, provider, request, |_| {}).unwrap();

        assert_eq!(response.run.status, AiRunStatus::Failed);
        assert_eq!(
            response.error.as_ref().unwrap().code,
            AiErrorCode::ProviderNonZeroExit
        );
        assert_eq!(response.diagnostics.as_ref().unwrap().exit_code, Some(7));
        assert!(response
            .diagnostics
            .as_ref()
            .unwrap()
            .stderr
            .as_deref()
            .unwrap()
            .contains("provider stderr"));
        assert_eq!(
            response.session.messages.last().unwrap().role,
            AiMessageRole::Error
        );
    }

    #[test]
    fn malformed_json_output_fails_safely() {
        let state = AiRuntimeState::default();
        let provider = fixed_output_provider("{not json", 5);
        let request = request("workspace", Some("session"), "Hello");

        let response = run_ai_conversation(&state, provider, request, |_| {}).unwrap();

        assert_eq!(response.run.status, AiRunStatus::Failed);
        assert_eq!(
            response.error.as_ref().unwrap().code,
            AiErrorCode::ProviderOutputMalformed
        );
    }

    #[test]
    fn timeout_leaves_failed_session_state() {
        let state = AiRuntimeState::default();
        let provider = sleep_provider(1);
        let request = request("workspace", Some("session"), "Hello");

        let response = run_ai_conversation(&state, provider, request, |_| {}).unwrap();

        assert_eq!(response.run.status, AiRunStatus::Failed);
        assert_eq!(
            response.error.as_ref().unwrap().code,
            AiErrorCode::ProviderTimedOut
        );
        assert_eq!(response.session.last_run_status, AiRunStatus::Failed);
    }

    #[test]
    fn cancellation_leaves_cancelled_session_state() {
        let state = Arc::new(AiRuntimeState::default());
        let provider = sleep_provider(5);
        let request = request("workspace", Some("session"), "Hello");
        let runner_state = state.clone();
        let handle = thread::spawn(move || {
            run_ai_conversation(&runner_state, provider, request, |_| {}).unwrap()
        });

        let run_id = wait_for_active_run(&state);
        let cancelled = state.cancel_run(&run_id).unwrap();
        assert_eq!(cancelled.status, AiRunStatus::Cancelled);

        let response = handle.join().unwrap();
        assert_eq!(response.run.status, AiRunStatus::Cancelled);
        assert_eq!(response.session.last_run_status, AiRunStatus::Cancelled);
    }

    #[test]
    fn long_response_under_limit_is_returned() {
        let state = AiRuntimeState::default();
        let provider = long_output_provider(1500, 4096, 5);
        let request = request("workspace", Some("session"), "Long answer");

        let response = run_ai_conversation(&state, provider, request, |_| {}).unwrap();

        assert_eq!(response.run.status, AiRunStatus::Completed);
        assert!(response.assistant_message.unwrap().content.len() >= 1500);
    }

    #[test]
    fn output_over_limit_fails_without_corrupting_history() {
        let state = AiRuntimeState::default();
        let provider = long_output_provider(1500, 1024, 5);
        let request = request("workspace", Some("session"), "Long answer");

        let response = run_ai_conversation(&state, provider, request, |_| {}).unwrap();

        assert_eq!(response.run.status, AiRunStatus::Failed);
        assert_eq!(
            response.error.as_ref().unwrap().code,
            AiErrorCode::ProviderOutputTooLarge
        );
        assert_eq!(response.session.messages.len(), 2);
    }

    fn request(
        workspace_id: &str,
        session_id: Option<&str>,
        prompt: &str,
    ) -> AiConversationRequest {
        AiConversationRequest {
            workspace_id: workspace_id.to_owned(),
            session_id: session_id.map(str::to_owned),
            provider_id: None,
            document_id: Some("doc-1".to_owned()),
            document_path: Some("notes.md".to_owned()),
            prompt: prompt.to_owned(),
            context: context_snapshot(workspace_id),
            limits: Default::default(),
        }
    }

    fn context_snapshot(workspace_id: &str) -> AiContextSnapshot {
        AiContextSnapshot {
            workspace_id: workspace_id.to_owned(),
            scope: AiContextScope::CurrentFile,
            display_label: "Current file".to_owned(),
            document_id: Some("doc-1".to_owned()),
            document_path: Some("notes.md".to_owned()),
            document_revision: Some("rev-1".to_owned()),
            document_content_hash: Some("hash".to_owned()),
            selected_node_ids: Vec::new(),
            items: vec![AiContextItem {
                id: "item-1".to_owned(),
                kind: AiContextItemKind::MarkdownFile,
                label: "Current file".to_owned(),
                relative_path: Some("notes.md".to_owned()),
                node_ids: Vec::new(),
                content: "important context".to_owned(),
                byte_estimate: 17,
            }],
            byte_estimate: 17,
            token_estimate: 4,
            truncated: false,
            warnings: Vec::new(),
        }
    }

    fn provider(script: String, timeout_seconds: u64, max_output_bytes: usize) -> AiProviderConfig {
        AiProviderConfig {
            id: "provider".to_owned(),
            display_name: "Mock Provider".to_owned(),
            kind: AiProviderKind::Generic,
            executable_path: mock_provider_executable(script),
            argument_template: Vec::new(),
            health_check_args: Vec::new(),
            environment_allowlist: None,
            working_directory: None,
            timeout_seconds,
            max_output_bytes,
            enabled: true,
            last_health_status: Some(AiProviderHealthStatus {
                status: crate::ai::providers::AiProviderHealthState::Ok,
                checked_at: "2026-05-10T00:00:00Z".to_owned(),
                message: "ok".to_owned(),
                detail: None,
                exit_code: Some(0),
                duration_ms: Some(1),
            }),
        }
    }

    fn fixed_output_provider(output: &str, timeout_seconds: u64) -> AiProviderConfig {
        provider(fixed_output_script(output), timeout_seconds, 64 * 1024)
    }

    fn stdin_echo_provider(timeout_seconds: u64) -> AiProviderConfig {
        provider(stdin_echo_script(), timeout_seconds, 64 * 1024)
    }

    fn non_zero_provider(exit_code: i32, stderr: &str, timeout_seconds: u64) -> AiProviderConfig {
        provider(non_zero_script(exit_code, stderr), timeout_seconds, 64 * 1024)
    }

    fn sleep_provider(timeout_seconds: u64) -> AiProviderConfig {
        provider(sleep_script(), timeout_seconds, 64 * 1024)
    }

    fn long_output_provider(
        bytes: usize,
        max_output_bytes: usize,
        timeout_seconds: u64,
    ) -> AiProviderConfig {
        provider(long_output_script(bytes), timeout_seconds, max_output_bytes)
    }

    #[cfg(windows)]
    fn fixed_output_script(output: &str) -> String {
        format!(
            "@echo off\r\npowershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command \"$hex='{}'; [byte[]]$bytes = for ($i = 0; $i -lt $hex.Length; $i += 2) {{ [Convert]::ToByte($hex.Substring($i, 2), 16) }}; [Console]::OpenStandardOutput().Write($bytes, 0, $bytes.Length)\"\r\n",
            hex_bytes(output.as_bytes())
        )
    }

    #[cfg(unix)]
    fn fixed_output_script(output: &str) -> String {
        format!("#!/bin/sh\nprintf '%s' {}\n", shell_quote(output))
    }

    #[cfg(windows)]
    fn stdin_echo_script() -> String {
        "@echo off\r\npowershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command \"$text = [Console]::In.ReadToEnd(); [Console]::Out.Write($text)\"\r\n".to_owned()
    }

    #[cfg(unix)]
    fn stdin_echo_script() -> String {
        "#!/bin/sh\ncat\n".to_owned()
    }

    #[cfg(windows)]
    fn non_zero_script(exit_code: i32, stderr: &str) -> String {
        format!(
            "@echo off\r\npowershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command \"$hex='{}'; [byte[]]$bytes = for ($i = 0; $i -lt $hex.Length; $i += 2) {{ [Convert]::ToByte($hex.Substring($i, 2), 16) }}; [Console]::OpenStandardError().Write($bytes, 0, $bytes.Length); exit {exit_code}\"\r\n",
            hex_bytes(stderr.as_bytes())
        )
    }

    #[cfg(unix)]
    fn non_zero_script(exit_code: i32, stderr: &str) -> String {
        format!(
            "#!/bin/sh\nprintf '%s' {} >&2\nexit {exit_code}\n",
            shell_quote(stderr)
        )
    }

    #[cfg(windows)]
    fn sleep_script() -> String {
        "@echo off\r\nping -n 4 127.0.0.1 >nul\r\n".to_owned()
    }

    #[cfg(unix)]
    fn sleep_script() -> String {
        "#!/bin/sh\nsleep 3\n".to_owned()
    }

    #[cfg(windows)]
    fn long_output_script(bytes: usize) -> String {
        format!(
            "@echo off\r\npowershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command \"[Console]::Out.Write(('x' * {bytes}))\"\r\n"
        )
    }

    #[cfg(unix)]
    fn long_output_script(bytes: usize) -> String {
        format!("#!/bin/sh\nyes x | tr -d '\\n' | head -c {bytes}\n")
    }

    fn mock_provider_executable(script: String) -> String {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join(mock_executable_name("mock-ai-provider"));
        fs::write(&path, script).unwrap();
        make_executable(&path);
        std::mem::forget(temp);
        path.display().to_string()
    }

    #[cfg(windows)]
    fn mock_executable_name(stem: &str) -> String {
        format!("{stem}.cmd")
    }

    #[cfg(not(windows))]
    fn mock_executable_name(stem: &str) -> String {
        stem.to_owned()
    }

    #[cfg(unix)]
    fn make_executable(path: &Path) {
        use std::os::unix::fs::PermissionsExt;

        let mut permissions = fs::metadata(path).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(path, permissions).unwrap();
    }

    #[cfg(not(unix))]
    fn make_executable(_path: &Path) {
    }

    #[cfg(unix)]
    fn shell_quote(value: &str) -> String {
        format!("'{}'", value.replace('\'', "'\"'\"'"))
    }

    #[cfg(windows)]
    fn hex_bytes(bytes: &[u8]) -> String {
        bytes.iter().map(|byte| format!("{byte:02x}")).collect()
    }

    fn wait_for_active_run(state: &AiRuntimeState) -> String {
        let started = Instant::now();
        loop {
            if let Some(run_id) = state
                .active_runs
                .lock()
                .unwrap()
                .keys()
                .next()
                .map(ToOwned::to_owned)
            {
                return run_id;
            }
            assert!(started.elapsed() < Duration::from_secs(2));
            thread::sleep(Duration::from_millis(10));
        }
    }
}
