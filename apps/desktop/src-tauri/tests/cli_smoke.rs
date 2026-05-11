use serde_json::{json, Value};
use std::fs;
use std::process::{Command, Output};

fn cli_output(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_how-to-think"))
        .args(args)
        .output()
        .expect("CLI binary should run")
}

fn stdout(output: &Output) -> String {
    String::from_utf8(output.stdout.clone()).expect("stdout should be UTF-8")
}

fn stderr(output: &Output) -> String {
    String::from_utf8(output.stderr.clone()).expect("stderr should be UTF-8")
}

fn json_output(args: &[&str]) -> (Output, Value) {
    let output = cli_output(args);
    let envelope: Value = serde_json::from_str(&stdout(&output)).unwrap();
    (output, envelope)
}

fn node_id_by_path(envelope: &Value, path: &[&str]) -> String {
    let expected = json!(path);
    envelope["data"]["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|node| node["path"] == expected)
        .and_then(|node| node["id"].as_str())
        .expect("node path should exist in mindmap output")
        .to_owned()
}

#[test]
fn help_human_output_succeeds() {
    let output = cli_output(&["help"]);

    assert!(output.status.success(), "stderr: {}", stderr(&output));
    let stdout = stdout(&output);
    assert!(stdout.contains("Usage:"));
    assert!(stdout.contains("doctor"));
}

#[test]
fn help_json_output_uses_result_envelope() {
    let output = cli_output(&["--json", "help"]);

    assert!(output.status.success(), "stderr: {}", stderr(&output));
    let envelope: Value = serde_json::from_str(&stdout(&output)).unwrap();
    assert_eq!(envelope["ok"], true);
    assert_eq!(envelope["contract_version"], "2026-05-10.v1");
    assert_eq!(envelope["schema_version"], "1.0.0");
    assert_eq!(envelope["operation_id"], "help");
    assert!(envelope["data"]["commands"].is_array());
}

#[test]
fn version_human_and_json_outputs_succeed() {
    let human = cli_output(&["version"]);
    assert!(human.status.success(), "stderr: {}", stderr(&human));
    assert!(stdout(&human).contains("How to Think CLI"));

    let json = cli_output(&["version", "--format", "json"]);
    assert!(json.status.success(), "stderr: {}", stderr(&json));
    let envelope: Value = serde_json::from_str(&stdout(&json)).unwrap();
    assert_eq!(envelope["ok"], true);
    assert_eq!(envelope["operation_id"], "version");
    assert_eq!(envelope["data"]["version"], env!("CARGO_PKG_VERSION"));
}

#[test]
fn doctor_human_and_json_outputs_succeed_with_explicit_settings_dirs() {
    let temp = tempfile::tempdir().unwrap();
    let data_dir = temp.path().join("data");
    let config_dir = temp.path().join("config");

    let human = cli_output(&[
        "doctor",
        "--app-data-dir",
        data_dir.to_str().unwrap(),
        "--app-config-dir",
        config_dir.to_str().unwrap(),
    ]);
    assert!(human.status.success(), "stderr: {}", stderr(&human));
    assert!(stdout(&human).contains("Checks:"));

    let json = cli_output(&[
        "--json",
        "doctor",
        "--app-data-dir",
        data_dir.to_str().unwrap(),
        "--app-config-dir",
        config_dir.to_str().unwrap(),
        "--non-interactive",
    ]);
    assert!(json.status.success(), "stderr: {}", stderr(&json));
    let envelope: Value = serde_json::from_str(&stdout(&json)).unwrap();
    assert_eq!(envelope["ok"], true);
    assert_eq!(envelope["operation_id"], "diagnostics.doctor");
    assert_eq!(envelope["data"]["non_interactive"], true);
    assert!(envelope["data"]["checks"].as_array().unwrap().len() >= 3);
}

#[test]
fn invalid_json_command_returns_contract_exit_code() {
    let output = cli_output(&["--json", "not-a-command"]);

    assert_eq!(output.status.code(), Some(50));
    let envelope: Value = serde_json::from_str(&stdout(&output)).unwrap();
    assert_eq!(envelope["ok"], false);
    assert_eq!(envelope["error"]["code"], "command_unavailable");
}

#[test]
fn ui_review_json_returns_structured_handoff_without_prompting() {
    let temp = tempfile::tempdir().unwrap();
    let data_dir = temp.path().join("data");
    let config_dir = temp.path().join("config");

    let output = cli_output(&[
        "--json",
        "--non-interactive",
        "ui.review",
        "--target",
        "workspace:workspace-1/file:notes.md",
        "--reason",
        "Review dirty editor state.",
        "--app-data-dir",
        data_dir.to_str().unwrap(),
        "--app-config-dir",
        config_dir.to_str().unwrap(),
    ]);

    assert_eq!(output.status.code(), Some(50));
    let envelope: Value = serde_json::from_str(&stdout(&output)).unwrap();
    assert_eq!(envelope["ok"], false);
    assert_eq!(envelope["operation_id"], "ui.review");
    assert_eq!(envelope["error"]["code"], "ui_required");
    assert_eq!(envelope["ui_action"]["kind"], "open_review_surface");
    assert_eq!(
        envelope["ui_action"]["target"],
        "workspace:workspace-1/file:notes.md"
    );
}

#[test]
fn workspace_file_lifecycle_json_uses_shared_guards() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    let data_dir = temp.path().join("data");
    let config_dir = temp.path().join("config");
    fs::create_dir_all(&workspace).unwrap();

    let (_, opened_workspace) = json_output(&[
        "--json",
        "workspace.open",
        "--workspace",
        workspace.to_str().unwrap(),
        "--app-data-dir",
        data_dir.to_str().unwrap(),
        "--app-config-dir",
        config_dir.to_str().unwrap(),
    ]);
    assert_eq!(opened_workspace["ok"], true);
    assert_eq!(opened_workspace["operation_id"], "workspace.open");

    let (_, created) = json_output(&[
        "--json",
        "workspace.file.create",
        "--workspace",
        workspace.to_str().unwrap(),
        "--path",
        "plan.md",
        "--content",
        "# Plan\n\n[[Topic]]",
        "--app-data-dir",
        data_dir.to_str().unwrap(),
        "--app-config-dir",
        config_dir.to_str().unwrap(),
    ]);
    assert_eq!(created["ok"], true);
    assert_eq!(created["data"]["relativePath"], "plan.md");

    let (_, listed) = json_output(&[
        "--json",
        "workspace.files.list",
        "--workspace",
        workspace.to_str().unwrap(),
        "--app-data-dir",
        data_dir.to_str().unwrap(),
        "--app-config-dir",
        config_dir.to_str().unwrap(),
    ]);
    assert_eq!(listed["data"]["files"].as_array().unwrap().len(), 1);

    let (_, opened) = json_output(&[
        "--json",
        "workspace.file.open",
        "--workspace",
        workspace.to_str().unwrap(),
        "--path",
        "plan.md",
        "--app-data-dir",
        data_dir.to_str().unwrap(),
        "--app-config-dir",
        config_dir.to_str().unwrap(),
    ]);
    assert_eq!(opened["ok"], true);
    assert_eq!(opened["data"]["content"], "# Plan\n\n[[Topic]]");
    let open_version = serde_json::to_string(&opened["data"]["version"]).unwrap();

    let (_, saved) = json_output(&[
        "--json",
        "workspace.file.save",
        "--workspace",
        workspace.to_str().unwrap(),
        "--path",
        "plan.md",
        "--content",
        "# Plan\n\n## Saved",
        "--expected-version",
        &open_version,
        "--app-data-dir",
        data_dir.to_str().unwrap(),
        "--app-config-dir",
        config_dir.to_str().unwrap(),
    ]);
    assert_eq!(saved["ok"], true);
    assert_eq!(
        fs::read_to_string(workspace.join("plan.md")).unwrap(),
        "# Plan\n\n## Saved"
    );
    let saved_version = serde_json::to_string(&saved["data"]["version"]).unwrap();

    let (rename_probe_output, rename_probe) = json_output(&[
        "--json",
        "workspace.file.rename",
        "--workspace",
        workspace.to_str().unwrap(),
        "--path",
        "plan.md",
        "--new-path",
        "renamed.md",
        "--expected-version",
        &saved_version,
        "--app-data-dir",
        data_dir.to_str().unwrap(),
        "--app-config-dir",
        config_dir.to_str().unwrap(),
    ]);
    assert_eq!(rename_probe_output.status.code(), Some(30));
    assert_eq!(rename_probe["error"]["code"], "confirmation_required");
    let rename_token = rename_probe["needs_confirmation"]["confirm_token"]
        .as_str()
        .unwrap();

    let (_, renamed) = json_output(&[
        "--json",
        "workspace.file.rename",
        "--workspace",
        workspace.to_str().unwrap(),
        "--path",
        "plan.md",
        "--new-path",
        "renamed.md",
        "--expected-version",
        &saved_version,
        "--confirm-token",
        rename_token,
        "--app-data-dir",
        data_dir.to_str().unwrap(),
        "--app-config-dir",
        config_dir.to_str().unwrap(),
    ]);
    assert_eq!(renamed["ok"], true);
    assert_eq!(renamed["data"]["newRelativePath"], "renamed.md");
    let renamed_version = serde_json::to_string(&renamed["data"]["file"]["version"]).unwrap();

    let (delete_probe_output, delete_probe) = json_output(&[
        "--json",
        "workspace.file.delete",
        "--workspace",
        workspace.to_str().unwrap(),
        "--path",
        "renamed.md",
        "--expected-version",
        &renamed_version,
        "--app-data-dir",
        data_dir.to_str().unwrap(),
        "--app-config-dir",
        config_dir.to_str().unwrap(),
    ]);
    assert_eq!(delete_probe_output.status.code(), Some(30));
    let delete_token = delete_probe["needs_confirmation"]["confirm_token"]
        .as_str()
        .unwrap();

    let (_, deleted) = json_output(&[
        "--json",
        "workspace.file.delete",
        "--workspace",
        workspace.to_str().unwrap(),
        "--path",
        "renamed.md",
        "--expected-version",
        &renamed_version,
        "--confirm-token",
        delete_token,
        "--app-data-dir",
        data_dir.to_str().unwrap(),
        "--app-config-dir",
        config_dir.to_str().unwrap(),
    ]);
    assert_eq!(deleted["ok"], true);
    assert!(!workspace.join("renamed.md").exists());
}

#[test]
fn markdown_parse_and_link_resolution_json_report_diagnostics() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    let data_dir = temp.path().join("data");
    let config_dir = temp.path().join("config");
    fs::create_dir_all(workspace.join("archive")).unwrap();
    fs::write(
        workspace.join("Current.md"),
        "# Current\n\n## See [[Topic]] and [Deep](Topic.md#deep-thought)\n\nParagraph",
    )
    .unwrap();
    fs::write(workspace.join("Topic.md"), "# Topic\n\n## Deep Thought").unwrap();

    let (_, parsed) = json_output(&[
        "--json",
        "markdown.parse",
        "--workspace",
        workspace.to_str().unwrap(),
        "--path",
        "Current.md",
        "--app-data-dir",
        data_dir.to_str().unwrap(),
        "--app-config-dir",
        config_dir.to_str().unwrap(),
    ]);
    assert_eq!(parsed["ok"], true);
    assert_eq!(parsed["data"]["status"], "parsed");
    assert!(parsed["data"]["diagnostics"].as_array().unwrap().len() >= 1);

    let (_, resolved) = json_output(&[
        "--json",
        "markdown.links.resolve",
        "--workspace",
        workspace.to_str().unwrap(),
        "--path",
        "Current.md",
        "--app-data-dir",
        data_dir.to_str().unwrap(),
        "--app-config-dir",
        config_dir.to_str().unwrap(),
    ]);
    assert_eq!(resolved["ok"], true);
    assert_eq!(resolved["data"]["links"].as_array().unwrap().len(), 2);
    assert!(resolved["data"]["links"]
        .as_array()
        .unwrap()
        .iter()
        .all(|link| link["status"] == "resolved"));

    fs::write(workspace.join("archive").join("Topic.md"), "# Archived").unwrap();
    let (_, ambiguous) = json_output(&[
        "--json",
        "markdown.links.resolve",
        "--workspace",
        workspace.to_str().unwrap(),
        "--path",
        "Current.md",
        "--link-target",
        "Topic",
        "--link-kind",
        "wiki",
        "--app-data-dir",
        data_dir.to_str().unwrap(),
        "--app-config-dir",
        config_dir.to_str().unwrap(),
    ]);
    assert_eq!(ambiguous["data"]["links"][0]["status"], "ambiguous");
    assert_eq!(
        ambiguous["data"]["links"][0]["diagnostics"][0]["code"],
        "ambiguous_target"
    );
}

#[test]
fn mindmap_cli_reads_mutates_confirms_and_serializes_markdown() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    let data_dir = temp.path().join("data");
    let config_dir = temp.path().join("config");
    fs::create_dir_all(&workspace).unwrap();
    fs::write(workspace.join("plan.md"), "# Plan\n\n## Alpha\n\n## Beta\n").unwrap();

    let (_, created) = json_output(&[
        "--json",
        "mindmap.create",
        "--workspace",
        workspace.to_str().unwrap(),
        "--path",
        "new-map.md",
        "--title",
        "Roadmap",
        "--app-data-dir",
        data_dir.to_str().unwrap(),
        "--app-config-dir",
        config_dir.to_str().unwrap(),
    ]);
    assert_eq!(created["ok"], true);
    assert_eq!(
        fs::read_to_string(workspace.join("new-map.md")).unwrap(),
        "# Roadmap\n"
    );

    let (_, read) = json_output(&[
        "--json",
        "mindmap.read",
        "--workspace",
        workspace.to_str().unwrap(),
        "--path",
        "plan.md",
        "--app-data-dir",
        data_dir.to_str().unwrap(),
        "--app-config-dir",
        config_dir.to_str().unwrap(),
    ]);
    assert_eq!(read["ok"], true);
    assert_eq!(read["data"]["summary"]["contentNodeCount"], 3);
    let alpha_id = node_id_by_path(&read, &["Plan", "Alpha"]);
    let version = serde_json::to_string(&read["data"]["version"]).unwrap();

    let (_, added) = json_output(&[
        "--json",
        "mindmap.node.add",
        "--workspace",
        workspace.to_str().unwrap(),
        "--path",
        "plan.md",
        "--parent-id",
        &alpha_id,
        "--text",
        "Detail",
        "--expected-version",
        &version,
        "--app-data-dir",
        data_dir.to_str().unwrap(),
        "--app-config-dir",
        config_dir.to_str().unwrap(),
    ]);
    assert_eq!(added["ok"], true);
    assert!(fs::read_to_string(workspace.join("plan.md"))
        .unwrap()
        .contains("### Detail"));
    let added_version = serde_json::to_string(&added["data"]["version"]).unwrap();
    let detail_id = node_id_by_path(&added, &["Plan", "Alpha", "Detail"]);
    let plan_id = node_id_by_path(&added, &["Plan"]);

    let (cycle_output, cycle_error) = json_output(&[
        "--json",
        "mindmap.branch.move",
        "--workspace",
        workspace.to_str().unwrap(),
        "--path",
        "plan.md",
        "--node-id",
        &plan_id,
        "--parent-id",
        &alpha_id,
        "--expected-version",
        &added_version,
        "--app-data-dir",
        data_dir.to_str().unwrap(),
        "--app-config-dir",
        config_dir.to_str().unwrap(),
    ]);
    assert_eq!(cycle_output.status.code(), Some(10));
    assert_eq!(cycle_error["error"]["code"], "validation_error");
    assert!(fs::read_to_string(workspace.join("plan.md"))
        .unwrap()
        .contains("### Detail"));

    let (_, renamed) = json_output(&[
        "--json",
        "mindmap.node.update",
        "--workspace",
        workspace.to_str().unwrap(),
        "--path",
        "plan.md",
        "--node-id",
        &detail_id,
        "--text",
        "Renamed detail",
        "--expected-version",
        &added_version,
        "--app-data-dir",
        data_dir.to_str().unwrap(),
        "--app-config-dir",
        config_dir.to_str().unwrap(),
    ]);
    assert_eq!(renamed["ok"], true);
    assert!(fs::read_to_string(workspace.join("plan.md"))
        .unwrap()
        .contains("### Renamed detail"));
    let renamed_version = serde_json::to_string(&renamed["data"]["version"]).unwrap();
    let renamed_detail_id = node_id_by_path(&renamed, &["Plan", "Alpha", "Renamed detail"]);

    let (delete_probe_output, delete_probe) = json_output(&[
        "--json",
        "mindmap.branch.delete",
        "--workspace",
        workspace.to_str().unwrap(),
        "--path",
        "plan.md",
        "--node-id",
        &renamed_detail_id,
        "--expected-version",
        &renamed_version,
        "--app-data-dir",
        data_dir.to_str().unwrap(),
        "--app-config-dir",
        config_dir.to_str().unwrap(),
    ]);
    assert_eq!(delete_probe_output.status.code(), Some(30));
    assert_eq!(delete_probe["error"]["code"], "confirmation_required");
    assert_eq!(
        delete_probe["needs_confirmation"]["kind"],
        "destructive_mindmap"
    );
    let delete_token = delete_probe["needs_confirmation"]["confirm_token"]
        .as_str()
        .unwrap();

    let (_, deleted) = json_output(&[
        "--json",
        "mindmap.branch.delete",
        "--workspace",
        workspace.to_str().unwrap(),
        "--path",
        "plan.md",
        "--node-id",
        &renamed_detail_id,
        "--expected-version",
        &renamed_version,
        "--confirm-token",
        delete_token,
        "--app-data-dir",
        data_dir.to_str().unwrap(),
        "--app-config-dir",
        config_dir.to_str().unwrap(),
    ]);
    assert_eq!(deleted["ok"], true);
    let final_markdown = fs::read_to_string(workspace.join("plan.md")).unwrap();
    assert!(!final_markdown.contains("Renamed detail"));
    assert!(final_markdown.contains("## Alpha"));
    assert!(final_markdown.contains("## Beta"));
}

#[test]
fn invalid_path_and_invalid_utf8_return_typed_json_errors() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    let data_dir = temp.path().join("data");
    let config_dir = temp.path().join("config");
    fs::create_dir_all(&workspace).unwrap();

    let (path_output, path_error) = json_output(&[
        "--json",
        "workspace.file.open",
        "--workspace",
        workspace.to_str().unwrap(),
        "--path",
        "../outside.md",
        "--app-data-dir",
        data_dir.to_str().unwrap(),
        "--app-config-dir",
        config_dir.to_str().unwrap(),
    ]);
    assert_eq!(path_output.status.code(), Some(10));
    assert_eq!(path_error["error"]["code"], "invalid_relative_path");

    let (markdown_path_output, markdown_path_error) = json_output(&[
        "--json",
        "markdown.parse",
        "--content",
        "# Unsafe source",
        "--path",
        "../outside.md",
        "--app-data-dir",
        data_dir.to_str().unwrap(),
        "--app-config-dir",
        config_dir.to_str().unwrap(),
    ]);
    assert_eq!(markdown_path_output.status.code(), Some(10));
    assert_eq!(
        markdown_path_error["error"]["code"],
        "invalid_relative_path"
    );

    fs::write(workspace.join("bad.md"), [0xff, 0xfe]).unwrap();
    let (utf8_output, utf8_error) = json_output(&[
        "--json",
        "workspace.file.open",
        "--workspace",
        workspace.to_str().unwrap(),
        "--path",
        "bad.md",
        "--app-data-dir",
        data_dir.to_str().unwrap(),
        "--app-config-dir",
        config_dir.to_str().unwrap(),
    ]);
    assert_eq!(utf8_output.status.code(), Some(10));
    assert_eq!(utf8_error["error"]["code"], "validation_error");
    assert_eq!(
        utf8_error["error"]["details"]["workspaceCode"],
        "InvalidUtf8"
    );
}
