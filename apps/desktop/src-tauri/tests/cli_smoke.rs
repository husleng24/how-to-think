use serde_json::Value;
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
