use how_to_think_desktop_lib::cli::{execute, parse_args, PRIMARY_CLI_COMMANDS};
use how_to_think_desktop_lib::command_service::{
    CommandService, CLI_CONTRACT_VERSION, CLI_RESULT_SCHEMA_VERSION,
};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

const COVERAGE_MATRIX: &str = include_str!("../../docs/native-cli-capability-matrix.json");
const OPERATOR_GUIDE: &str = include_str!("../../docs/native-cli-operator-guide.md");

fn parse_json_stdout(execution: &how_to_think_desktop_lib::cli::CliExecution) -> Value {
    serde_json::from_str(&execution.stdout).expect("CLI stdout should be a JSON envelope")
}

#[test]
fn coverage_matrix_matches_registered_cli_commands() {
    let matrix: Value =
        serde_json::from_str(COVERAGE_MATRIX).expect("coverage matrix should be valid JSON");
    assert_eq!(matrix["contractVersion"], CLI_CONTRACT_VERSION);
    assert_eq!(matrix["resultSchemaVersion"], CLI_RESULT_SCHEMA_VERSION);

    let allowed_dispositions = matrix["allowedDispositions"]
        .as_array()
        .expect("allowedDispositions should be an array")
        .iter()
        .map(|value| value.as_str().unwrap().to_owned())
        .collect::<BTreeSet<_>>();
    assert_eq!(
        allowed_dispositions,
        BTreeSet::from([
            "cli_supported_with_confirmation".to_owned(),
            "cli_wakes_desktop_ui".to_owned(),
            "headless_cli_supported".to_owned(),
            "intentionally_unsupported".to_owned(),
        ])
    );

    let entries = matrix["commands"]
        .as_array()
        .expect("commands should be an array");
    let mut matrix_commands = BTreeMap::new();

    for entry in entries {
        let command = entry["command"]
            .as_str()
            .expect("command should be a string");
        let operation_id = entry["operationId"]
            .as_str()
            .expect("operationId should be a string");
        let disposition = entry["disposition"]
            .as_str()
            .expect("disposition should be a string");
        assert!(
            allowed_dispositions.contains(disposition),
            "{command} has unknown disposition {disposition}"
        );
        assert!(
            !entry["group"].as_str().unwrap_or_default().is_empty(),
            "{command} should declare a group"
        );
        assert!(
            !entry["safety"].as_str().unwrap_or_default().is_empty(),
            "{command} should document safety behavior"
        );
        assert!(
            entry["sourceIssues"]
                .as_array()
                .is_some_and(|items| !items.is_empty()),
            "{command} should trace to source issues"
        );
        assert!(
            entry["testCoverage"]
                .as_array()
                .is_some_and(|items| !items.is_empty()),
            "{command} should trace to test coverage"
        );
        assert!(
            parse_args(&[command.to_owned()]).is_ok(),
            "{command} should be accepted by CLI parsing"
        );
        assert!(
            matrix_commands
                .insert(command.to_owned(), operation_id.to_owned())
                .is_none(),
            "{command} should appear only once in the coverage matrix"
        );
    }

    let expected_commands = PRIMARY_CLI_COMMANDS
        .iter()
        .map(|(command, operation_id)| (command.to_string(), operation_id.to_string()))
        .collect::<BTreeMap<_, _>>();
    assert_eq!(matrix_commands, expected_commands);

    let help_commands = CommandService::help_data()
        .commands
        .iter()
        .map(|command| command.name.to_owned())
        .collect::<BTreeSet<_>>();
    let expected_help_commands = PRIMARY_CLI_COMMANDS
        .iter()
        .map(|(command, _)| command.to_string())
        .collect::<BTreeSet<_>>();
    assert_eq!(help_commands, expected_help_commands);
}

#[test]
fn operator_guide_documents_cli_contract_surfaces() {
    for section in [
        "## Locating the Binary",
        "## Global Flags",
        "## Command Coverage",
        "## JSON Envelope",
        "## Exit Codes",
        "## Safety Behavior",
        "## Examples",
        "## First-Version Non-Goals",
        "## Validation",
    ] {
        assert!(
            OPERATOR_GUIDE.contains(section),
            "operator guide should include {section}"
        );
    }

    for (command, _) in PRIMARY_CLI_COMMANDS {
        assert!(
            OPERATOR_GUIDE.contains(&format!("`{command}`")),
            "operator guide should mention `{command}`"
        );
    }

    for non_goal in [
        "No shell completion",
        "No package-manager publishing",
        "No remote service API or cloud automation platform",
        "No bypass of desktop review or confirmation",
        "No full GUI replacement",
    ] {
        assert!(
            OPERATOR_GUIDE.contains(non_goal),
            "operator guide should document non-goal: {non_goal}"
        );
    }
}

#[test]
fn unsupported_and_ui_only_commands_return_documented_envelopes() {
    let temp = tempfile::tempdir().unwrap();
    let data_dir = temp.path().join("data");
    let config_dir = temp.path().join("config");

    let unsupported = execute([
        "--json",
        "--app-data-dir",
        data_dir.to_str().unwrap(),
        "--app-config-dir",
        config_dir.to_str().unwrap(),
        "mindmap.collapse",
    ]);
    let unsupported_json = parse_json_stdout(&unsupported);
    assert_eq!(unsupported.exit_code, 50);
    assert_eq!(unsupported_json["ok"], false);
    assert_eq!(unsupported_json["operation_id"], "mindmap.collapse");
    assert_eq!(unsupported_json["error"]["code"], "unsupported_operation");

    let ui_required = execute([
        "--json",
        "--non-interactive",
        "--app-data-dir",
        data_dir.to_str().unwrap(),
        "--app-config-dir",
        config_dir.to_str().unwrap(),
        "mindmap.focus-node",
        "--workspace",
        temp.path().to_str().unwrap(),
        "--path",
        "plan.md",
        "--node-id",
        "root",
    ]);
    let ui_json = parse_json_stdout(&ui_required);
    assert_eq!(ui_required.exit_code, 50);
    assert_eq!(ui_json["ok"], false);
    assert_eq!(ui_json["operation_id"], "mindmap.focus-node");
    assert_eq!(ui_json["error"]["code"], "ui_required");
    assert_eq!(ui_json["ui_action"]["kind"], "focus_existing_window");
}
