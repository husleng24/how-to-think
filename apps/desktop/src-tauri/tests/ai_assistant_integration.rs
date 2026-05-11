use how_to_think_desktop_lib::ai::context::{
    build_context_snapshot, AiContextItemKind, AiContextLimits, AiContextScope, AiContextSnapshot,
    AiContextSnapshotRequest, AiContextWarningCode, AiMindMapDocument, AiMindMapNode,
};
use how_to_think_desktop_lib::ai::errors::AiErrorCode;
use how_to_think_desktop_lib::ai::providers::{
    check_provider_health, AiProviderConfig, AiProviderHealthState, AiProviderKind,
};
use how_to_think_desktop_lib::ai::runner::{run_ai_conversation, AiRuntimeState};
use how_to_think_desktop_lib::ai::session::{
    AiConversationLimits, AiConversationRequest, AiResponse, AiRunStatus,
};
use how_to_think_desktop_lib::errors::WorkspaceOperation;
use how_to_think_desktop_lib::models::WorkspaceRecord;
use how_to_think_desktop_lib::workspace::validate_workspace_root;
use std::collections::BTreeMap;
use std::env;
use std::fs;

const MOCK_PROVIDER_SCRIPT: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../scripts/mock-ai-provider.mjs"
);
const CURRENT_FILE: &str = "notes/plan.md";
const OPEN_FILE: &str = "notes/related.md";

#[test]
fn mock_provider_flow_covers_context_scopes_followups_and_no_file_mutation() {
    let temp = tempfile::tempdir().unwrap();
    fs::create_dir_all(temp.path().join("notes")).unwrap();
    fs::write(
        temp.path().join(CURRENT_FILE),
        "# Plan\n\n## Build\n\n- Add tests\n- Document operators\n",
    )
    .unwrap();
    fs::write(temp.path().join(OPEN_FILE), "# Related\n").unwrap();
    let original_markdown = fs::read_to_string(temp.path().join(CURRENT_FILE)).unwrap();
    let record = validate_workspace_root(temp.path(), WorkspaceOperation::SelectWorkspace).unwrap();
    let document = document();

    let selected_node = snapshot_for(
        &record,
        AiContextScope::SelectedNode,
        Some(document.clone()),
        AiContextLimits::default(),
    );
    let selected_branch = snapshot_for(
        &record,
        AiContextScope::SelectedBranch,
        Some(document.clone()),
        AiContextLimits::default(),
    );
    let current_file = snapshot_for(
        &record,
        AiContextScope::CurrentFile,
        None,
        AiContextLimits::default(),
    );
    let workspace_summary = snapshot_for(
        &record,
        AiContextScope::WorkspaceSummary,
        None,
        AiContextLimits::default(),
    );

    let snapshots = [
        (&selected_node, AiContextScope::SelectedNode),
        (&selected_branch, AiContextScope::SelectedBranch),
        (&current_file, AiContextScope::CurrentFile),
        (&workspace_summary, AiContextScope::WorkspaceSummary),
    ];
    for (snapshot, scope) in snapshots {
        assert_eq!(snapshot.scope, scope);
        assert!(!snapshot.items.is_empty());
    }
    assert_eq!(selected_node.items[0].kind, AiContextItemKind::MindMapNode);
    assert_eq!(
        selected_branch.items[0].kind,
        AiContextItemKind::MindMapBranch
    );
    assert_eq!(current_file.items[0].kind, AiContextItemKind::MarkdownFile);
    assert_eq!(
        workspace_summary.items[0].kind,
        AiContextItemKind::WorkspaceFileTree
    );

    let state = AiRuntimeState::default();
    let provider = mock_provider(&["success"], 5, 64 * 1024);
    let first = run_ai_conversation(
        &state,
        provider,
        conversation_request(
            &record.info.id,
            Some("session-flow"),
            "Summarize the selected node",
            selected_node.clone(),
        ),
        |_| {},
    )
    .unwrap();

    assert_eq!(first.run.status, AiRunStatus::Completed);
    assert!(first
        .assistant_message
        .as_ref()
        .unwrap()
        .content
        .contains("Latest prompt: Summarize the selected node"));

    let provider = mock_provider(&["success"], 5, 64 * 1024);
    let second = run_ai_conversation(
        &state,
        provider,
        conversation_request(
            &record.info.id,
            Some("session-flow"),
            "Follow up with the next action",
            selected_branch,
        ),
        |_| {},
    )
    .unwrap();
    let second_content = &second.assistant_message.as_ref().unwrap().content;

    assert_eq!(second.run.status, AiRunStatus::Completed);
    assert!(second_content.contains("Latest prompt: Follow up with the next action"));
    assert!(second_content.contains("User: Summarize the selected node"));
    assert_eq!(
        fs::read_to_string(temp.path().join(CURRENT_FILE)).unwrap(),
        original_markdown
    );
}

#[test]
fn mock_provider_reports_health_and_failure_modes_without_real_ai_tools() {
    let (_temp, record) = temp_record();
    let context = snapshot_for(
        &record,
        AiContextScope::CurrentFile,
        None,
        AiContextLimits::default(),
    );

    let health = check_provider_health(&mock_provider(&["success"], 5, 64 * 1024));
    assert_eq!(health.status, AiProviderHealthState::Ok);
    assert!(health.message.contains("mock-ai-provider"));

    let malformed = run_with_provider(&record.info.id, context.clone(), &["malformed"]);
    assert_eq!(malformed.run.status, AiRunStatus::Failed);
    assert_eq!(
        malformed.error.as_ref().unwrap().code,
        AiErrorCode::ProviderOutputMalformed
    );

    let non_zero = run_with_provider(&record.info.id, context.clone(), &["non-zero"]);
    assert_eq!(non_zero.run.status, AiRunStatus::Failed);
    assert_eq!(
        non_zero.error.as_ref().unwrap().code,
        AiErrorCode::ProviderNonZeroExit
    );
    assert_eq!(non_zero.diagnostics.as_ref().unwrap().exit_code, Some(7));
    assert!(non_zero
        .diagnostics
        .as_ref()
        .unwrap()
        .stderr
        .as_deref()
        .unwrap()
        .contains("forced non-zero"));

    let oversized =
        run_with_sized_provider(&record.info.id, context.clone(), &["long", "2048"], 1, 1024);
    assert_eq!(oversized.run.status, AiRunStatus::Failed);
    assert_eq!(
        oversized.error.as_ref().unwrap().code,
        AiErrorCode::ProviderOutputTooLarge
    );

    let timed_out =
        run_with_sized_provider(&record.info.id, context, &["timeout", "5000"], 1, 64 * 1024);
    assert_eq!(timed_out.run.status, AiRunStatus::Failed);
    assert_eq!(
        timed_out.error.as_ref().unwrap().code,
        AiErrorCode::ProviderTimedOut
    );

    let missing = run_ai_conversation(
        &AiRuntimeState::default(),
        missing_provider(),
        conversation_request(
            &record.info.id,
            Some("missing-session"),
            "Will not start",
            snapshot_for(
                &record,
                AiContextScope::CurrentFile,
                None,
                AiContextLimits::default(),
            ),
        ),
        |_| {},
    )
    .unwrap_err();
    assert_eq!(missing.code, AiErrorCode::ProviderConfigInvalid);
}

#[test]
fn oversized_context_and_structured_suggestion_stay_reviewable_only() {
    let temp = tempfile::tempdir().unwrap();
    fs::create_dir_all(temp.path().join("notes")).unwrap();
    fs::write(
        temp.path().join(CURRENT_FILE),
        format!("# Plan\n\n{}\n", "detail ".repeat(200)),
    )
    .unwrap();
    let original_markdown = fs::read_to_string(temp.path().join(CURRENT_FILE)).unwrap();
    let record = validate_workspace_root(temp.path(), WorkspaceOperation::SelectWorkspace).unwrap();
    let truncated = build_context_snapshot(
        &record,
        AiContextSnapshotRequest {
            workspace_id: record.info.id.clone(),
            scope: Some(AiContextScope::CurrentFile),
            document: None,
            selected_node_id: None,
            current_file: Some(CURRENT_FILE.to_owned()),
            open_files: Vec::new(),
            content_revision: None,
            limits: AiContextLimits {
                max_context_bytes: 96,
                ..AiContextLimits::default()
            },
        },
    )
    .unwrap();

    assert!(truncated.truncated);
    assert!(truncated
        .warnings
        .iter()
        .any(|warning| warning.code == AiContextWarningCode::ContextTruncated));

    let response = run_ai_conversation(
        &AiRuntimeState::default(),
        mock_provider(&["suggestion"], 5, 64 * 1024),
        conversation_request(
            &record.info.id,
            Some("suggestion-session"),
            "Rewrite the selected branch with clearer steps.",
            truncated,
        ),
        |_| {},
    )
    .unwrap();

    assert_eq!(response.run.status, AiRunStatus::Completed);
    assert!(response
        .assistant_message
        .as_ref()
        .unwrap()
        .content
        .contains("Proposed draft rewrite"));
    assert_eq!(
        fs::read_to_string(temp.path().join(CURRENT_FILE)).unwrap(),
        original_markdown
    );
}

fn temp_record() -> (tempfile::TempDir, WorkspaceRecord) {
    let temp = tempfile::tempdir().unwrap();
    fs::create_dir_all(temp.path().join("notes")).unwrap();
    fs::write(temp.path().join(CURRENT_FILE), "# Notes\n\n## Detail\n").unwrap();
    fs::write(temp.path().join(OPEN_FILE), "# Related\n").unwrap();
    let record = validate_workspace_root(temp.path(), WorkspaceOperation::SelectWorkspace).unwrap();
    (temp, record)
}

fn snapshot_for(
    record: &WorkspaceRecord,
    scope: AiContextScope,
    document: Option<AiMindMapDocument>,
    limits: AiContextLimits,
) -> AiContextSnapshot {
    build_context_snapshot(
        record,
        AiContextSnapshotRequest {
            workspace_id: record.info.id.clone(),
            scope: Some(scope),
            document,
            selected_node_id: Some("plan".to_owned()),
            current_file: Some(CURRENT_FILE.to_owned()),
            open_files: vec![OPEN_FILE.to_owned()],
            content_revision: Some(3),
            limits,
        },
    )
    .unwrap()
}

fn conversation_request(
    workspace_id: &str,
    session_id: Option<&str>,
    prompt: &str,
    context: AiContextSnapshot,
) -> AiConversationRequest {
    AiConversationRequest {
        workspace_id: workspace_id.to_owned(),
        session_id: session_id.map(str::to_owned),
        provider_id: None,
        document_id: context.document_id.clone(),
        document_path: context.document_path.clone(),
        prompt: prompt.to_owned(),
        context,
        limits: AiConversationLimits::default(),
    }
}

fn run_with_provider(workspace_id: &str, context: AiContextSnapshot, args: &[&str]) -> AiResponse {
    run_with_sized_provider(workspace_id, context, args, 5, 64 * 1024)
}

fn run_with_sized_provider(
    workspace_id: &str,
    context: AiContextSnapshot,
    args: &[&str],
    timeout_seconds: u64,
    max_output_bytes: usize,
) -> AiResponse {
    run_ai_conversation(
        &AiRuntimeState::default(),
        mock_provider(args, timeout_seconds, max_output_bytes),
        conversation_request(
            workspace_id,
            Some("failure-session"),
            "Run fixture",
            context,
        ),
        |_| {},
    )
    .unwrap()
}

fn mock_provider(args: &[&str], timeout_seconds: u64, max_output_bytes: usize) -> AiProviderConfig {
    AiProviderConfig {
        id: "mock-provider".to_owned(),
        display_name: "Mock AI Provider".to_owned(),
        kind: AiProviderKind::Generic,
        executable_path: node_executable(),
        argument_template: mock_args(args),
        health_check_args: mock_args(&["health"]),
        environment_allowlist: None,
        working_directory: None,
        timeout_seconds,
        max_output_bytes,
        enabled: true,
        last_health_status: None,
    }
}

fn missing_provider() -> AiProviderConfig {
    let missing = env::temp_dir().join(executable_name(&format!(
        "missing-how-to-think-provider-{}",
        std::process::id()
    )));
    AiProviderConfig {
        id: "missing-provider".to_owned(),
        display_name: "Missing Provider".to_owned(),
        kind: AiProviderKind::Generic,
        executable_path: missing.display().to_string(),
        argument_template: Vec::new(),
        health_check_args: Vec::new(),
        environment_allowlist: None,
        working_directory: None,
        timeout_seconds: 5,
        max_output_bytes: 64 * 1024,
        enabled: true,
        last_health_status: None,
    }
}

fn mock_args(args: &[&str]) -> Vec<String> {
    let mut next = vec![MOCK_PROVIDER_SCRIPT.to_owned()];
    next.extend(args.iter().map(|arg| (*arg).to_owned()));
    next
}

fn node_executable() -> String {
    if let Ok(path) = env::var("HTT_NODE") {
        return path;
    }

    let candidates: &[&str] = if cfg!(windows) {
        &["node.exe", "node.cmd", "node.bat"]
    } else {
        &["node"]
    };

    for directory in env::split_paths(&env::var_os("PATH").unwrap_or_default()) {
        for name in candidates {
            let candidate = directory.join(name);
            if candidate.is_file() {
                return candidate.display().to_string();
            }
        }
    }

    panic!("Node.js is required to run the mock AI provider fixture");
}

fn executable_name(stem: &str) -> String {
    if cfg!(windows) {
        format!("{stem}.exe")
    } else {
        stem.to_owned()
    }
}

fn document() -> AiMindMapDocument {
    let nodes = BTreeMap::from([
        (
            "root".to_owned(),
            node("root", "Plan", None, &["plan", "risks"]),
        ),
        (
            "plan".to_owned(),
            node("plan", "Build validation", Some("root"), &["tests", "docs"]),
        ),
        (
            "tests".to_owned(),
            node("tests", "Add integration tests", Some("plan"), &[]),
        ),
        (
            "docs".to_owned(),
            node("docs", "Document operators", Some("plan"), &[]),
        ),
        (
            "risks".to_owned(),
            node("risks", "Risks", Some("root"), &[]),
        ),
    ]);

    AiMindMapDocument {
        id: "doc-1".to_owned(),
        title: "Plan".to_owned(),
        source_path: Some(CURRENT_FILE.to_owned()),
        root_node_id: "root".to_owned(),
        version: 1,
        nodes,
        created_at: "2026-05-10T00:00:00Z".to_owned(),
        updated_at: "2026-05-10T00:00:00Z".to_owned(),
    }
}

fn node(id: &str, text: &str, parent_id: Option<&str>, child_ids: &[&str]) -> AiMindMapNode {
    AiMindMapNode {
        id: id.to_owned(),
        text: text.to_owned(),
        parent_id: parent_id.map(str::to_owned),
        child_ids: child_ids
            .iter()
            .map(|child_id| (*child_id).to_owned())
            .collect(),
        collapsed: false,
        created_at: "2026-05-10T00:00:00Z".to_owned(),
        updated_at: "2026-05-10T00:00:00Z".to_owned(),
    }
}
