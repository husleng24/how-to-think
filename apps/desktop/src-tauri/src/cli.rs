use crate::command_service::{
    CliErrorCode, CliResultEnvelope, CommandService, CommandServicePaths, DoctorCheckStatus,
    DoctorReport, DoctorRequest, HelpData, VersionData,
};
use std::path::PathBuf;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutputMode {
    Human,
    Json,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CliOptions {
    pub command: CliCommand,
    pub output_mode: OutputMode,
    pub workspace_path: Option<PathBuf>,
    pub app_data_dir: Option<PathBuf>,
    pub app_config_dir: Option<PathBuf>,
    pub non_interactive: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CliCommand {
    Help,
    Version,
    Doctor,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CliExecution {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CliParseError {
    pub code: CliErrorCode,
    pub message: String,
}

pub fn run_from_env() -> i32 {
    let execution = execute(std::env::args().skip(1));

    if !execution.stdout.is_empty() {
        println!("{}", execution.stdout);
    }

    if !execution.stderr.is_empty() {
        eprintln!("{}", execution.stderr);
    }

    execution.exit_code
}

pub fn execute<I, S>(args: I) -> CliExecution
where
    I: IntoIterator<Item = S>,
    S: Into<String>,
{
    let args = args.into_iter().map(Into::into).collect::<Vec<_>>();
    let requested_output_mode = requested_output_mode(&args);

    match parse_args(&args) {
        Ok(options) => execute_options(options),
        Err(error) => {
            let envelope = CliResultEnvelope::error("cli.parse", error.code, error.message.clone());
            render_error(envelope, requested_output_mode.unwrap_or(OutputMode::Human))
        }
    }
}

pub fn parse_args(args: &[String]) -> Result<CliOptions, CliParseError> {
    let mut output_mode = OutputMode::Human;
    let mut workspace_path = None;
    let mut app_data_dir = None;
    let mut app_config_dir = None;
    let mut non_interactive = false;
    let mut command = None;
    let mut index = 0;

    while index < args.len() {
        match args[index].as_str() {
            "--json" => {
                output_mode = OutputMode::Json;
                index += 1;
            }
            "--format" | "--output" => {
                let value = required_value(args, index)?;
                output_mode = parse_output_mode(value)?;
                index += 2;
            }
            "--workspace" | "--workspace-path" => {
                let value = required_value(args, index)?;
                workspace_path = Some(PathBuf::from(value));
                index += 2;
            }
            "--app-data-dir" => {
                let value = required_value(args, index)?;
                app_data_dir = Some(PathBuf::from(value));
                index += 2;
            }
            "--app-config-dir" => {
                let value = required_value(args, index)?;
                app_config_dir = Some(PathBuf::from(value));
                index += 2;
            }
            "--non-interactive" => {
                non_interactive = true;
                index += 1;
            }
            "--help" | "-h" => {
                command = set_command(command, CliCommand::Help)?;
                index += 1;
            }
            "--version" | "-V" => {
                command = set_command(command, CliCommand::Version)?;
                index += 1;
            }
            value if value.starts_with('-') => {
                return Err(CliParseError {
                    code: CliErrorCode::InvalidArguments,
                    message: format!("Unknown flag `{value}`."),
                });
            }
            value => {
                command = set_command(command, parse_command(value)?)?;
                index += 1;
            }
        }
    }

    Ok(CliOptions {
        command: command.unwrap_or(CliCommand::Help),
        output_mode,
        workspace_path,
        app_data_dir,
        app_config_dir,
        non_interactive,
    })
}

fn execute_options(options: CliOptions) -> CliExecution {
    match options.command {
        CliCommand::Help => {
            let data = CommandService::help_data();
            let envelope = CliResultEnvelope::success("help", &data);
            render_success(envelope, options.output_mode, || render_help(&data))
        }
        CliCommand::Version => {
            let data = CommandService::version_data();
            let envelope = CliResultEnvelope::success("version", &data);
            render_success(envelope, options.output_mode, || render_version(&data))
        }
        CliCommand::Doctor => match CommandServicePaths::resolve(
            options.app_data_dir.clone(),
            options.app_config_dir.clone(),
        ) {
            Ok(paths) => {
                let service = CommandService::new(paths);
                let data = service.doctor(DoctorRequest {
                    workspace_path: options.workspace_path,
                    non_interactive: options.non_interactive,
                });
                let envelope = CliResultEnvelope::success("diagnostics.doctor", &data);
                render_success(envelope, options.output_mode, || render_doctor(&data))
            }
            Err(error) => {
                let envelope =
                    CliResultEnvelope::error("diagnostics.doctor", error.code, error.message);
                render_error(envelope, options.output_mode)
            }
        },
    }
}

fn render_success(
    envelope: CliResultEnvelope,
    output_mode: OutputMode,
    human: impl FnOnce() -> String,
) -> CliExecution {
    let stdout = match output_mode {
        OutputMode::Human => human(),
        OutputMode::Json => serialize_envelope(&envelope),
    };

    CliExecution {
        stdout,
        stderr: String::new(),
        exit_code: envelope.exit_code(),
    }
}

fn render_error(envelope: CliResultEnvelope, output_mode: OutputMode) -> CliExecution {
    let exit_code = envelope.exit_code();
    match output_mode {
        OutputMode::Json => CliExecution {
            stdout: serialize_envelope(&envelope),
            stderr: String::new(),
            exit_code,
        },
        OutputMode::Human => {
            let message = envelope
                .error
                .as_ref()
                .map(|error| error.message.as_str())
                .unwrap_or("Command failed.");

            CliExecution {
                stdout: String::new(),
                stderr: format!("Error: {message}\nRun `how-to-think help` for usage."),
                exit_code,
            }
        }
    }
}

fn render_help(data: &HelpData) -> String {
    let mut output = String::new();
    output.push_str("How to Think CLI\n\n");
    output.push_str("Usage:\n");
    output.push_str("  ");
    output.push_str(&data.usage);
    output.push_str("\n\nCommands:\n");
    for command in &data.commands {
        output.push_str(&format!("  {:<8} {}\n", command.name, command.description));
    }
    output.push_str("\nGlobal flags:\n");
    for flag in &data.global_flags {
        output.push_str(&format!("  {:<24} {}\n", flag.name, flag.description));
    }
    output
}

fn render_version(data: &VersionData) -> String {
    format!(
        "How to Think CLI {}\nContract: {}\nSchema: {}",
        data.version, data.contract_version, data.schema_version
    )
}

fn render_doctor(data: &DoctorReport) -> String {
    let mut output = String::new();
    output.push_str(&format!("How to Think CLI doctor {}\n", data.app_version));
    output.push_str(&format!("App data: {}\n", data.app_data_dir));
    output.push_str(&format!("App config: {}\n", data.app_config_dir));

    if let Some(workspace) = &data.workspace {
        output.push_str(&format!(
            "Workspace: {} ({} Markdown files)\n",
            workspace.display_path, workspace.file_count
        ));
    }

    output.push_str("Checks:\n");
    for check in &data.checks {
        let label = match check.status {
            DoctorCheckStatus::Ok => "ok",
            DoctorCheckStatus::Warning => "warning",
            DoctorCheckStatus::Error => "error",
        };
        output.push_str(&format!(
            "  {:<7} {:<20} {}\n",
            label, check.id, check.message
        ));
    }

    output
}

fn serialize_envelope(envelope: &CliResultEnvelope) -> String {
    serde_json::to_string_pretty(envelope).expect("CLI result envelopes must serialize")
}

fn parse_command(value: &str) -> Result<CliCommand, CliParseError> {
    match value {
        "help" => Ok(CliCommand::Help),
        "version" => Ok(CliCommand::Version),
        "doctor" | "diagnostics.doctor" => Ok(CliCommand::Doctor),
        _ => Err(CliParseError {
            code: CliErrorCode::CommandUnavailable,
            message: format!("Unknown command `{value}`."),
        }),
    }
}

fn parse_output_mode(value: &str) -> Result<OutputMode, CliParseError> {
    match value {
        "human" => Ok(OutputMode::Human),
        "json" => Ok(OutputMode::Json),
        _ => Err(CliParseError {
            code: CliErrorCode::InvalidOutputFormat,
            message: format!("Unsupported output format `{value}`."),
        }),
    }
}

fn requested_output_mode(args: &[String]) -> Option<OutputMode> {
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--json" => return Some(OutputMode::Json),
            "--format" | "--output" if args.get(index + 1).is_some_and(|value| value == "json") => {
                return Some(OutputMode::Json);
            }
            _ => index += 1,
        }
    }

    None
}

fn required_value(args: &[String], index: usize) -> Result<&str, CliParseError> {
    let flag = &args[index];
    let value = args.get(index + 1).ok_or_else(|| CliParseError {
        code: CliErrorCode::InvalidArguments,
        message: format!("Flag `{flag}` requires a value."),
    })?;

    if value.starts_with('-') {
        return Err(CliParseError {
            code: CliErrorCode::InvalidArguments,
            message: format!("Flag `{flag}` requires a value."),
        });
    }

    Ok(value)
}

fn set_command(
    current: Option<CliCommand>,
    next: CliCommand,
) -> Result<Option<CliCommand>, CliParseError> {
    if current.is_some() {
        return Err(CliParseError {
            code: CliErrorCode::InvalidArguments,
            message: "Only one command can be provided.".to_owned(),
        });
    }

    Ok(Some(next))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn parses_json_output_and_doctor_options() {
        let options = parse_args(&args(&[
            "--json",
            "--non-interactive",
            "--workspace",
            "notes",
            "doctor",
        ]))
        .unwrap();

        assert_eq!(options.command, CliCommand::Doctor);
        assert_eq!(options.output_mode, OutputMode::Json);
        assert!(options.non_interactive);
        assert_eq!(options.workspace_path, Some(PathBuf::from("notes")));
    }

    #[test]
    fn parses_output_mode_after_command() {
        let options = parse_args(&args(&["version", "--format", "json"])).unwrap();

        assert_eq!(options.command, CliCommand::Version);
        assert_eq!(options.output_mode, OutputMode::Json);
    }

    #[test]
    fn defaults_to_help_without_command() {
        let options = parse_args(&[]).unwrap();

        assert_eq!(options.command, CliCommand::Help);
        assert_eq!(options.output_mode, OutputMode::Human);
    }

    #[test]
    fn rejects_missing_flag_values() {
        let error = parse_args(&args(&["doctor", "--workspace"])).unwrap_err();

        assert_eq!(error.code, CliErrorCode::InvalidArguments);
        assert!(error.message.contains("requires a value"));
    }

    #[test]
    fn json_parse_errors_return_envelope_and_exit_code() {
        let execution = execute(args(&["--json", "unknown"]));
        let envelope: Value = serde_json::from_str(&execution.stdout).unwrap();

        assert_eq!(execution.exit_code, 50);
        assert_eq!(envelope["ok"], false);
        assert_eq!(envelope["error"]["code"], "command_unavailable");
    }

    #[test]
    fn json_version_returns_success_envelope() {
        let execution = execute(args(&["version", "--json"]));
        let envelope: Value = serde_json::from_str(&execution.stdout).unwrap();

        assert_eq!(execution.exit_code, 0);
        assert_eq!(envelope["ok"], true);
        assert_eq!(envelope["operation_id"], "version");
        assert_eq!(envelope["data"]["version"], env!("CARGO_PKG_VERSION"));
    }

    #[test]
    fn human_help_renders_usage_without_error() {
        let execution = execute(args(&["help"]));

        assert_eq!(execution.exit_code, 0);
        assert!(execution.stderr.is_empty());
        assert!(execution.stdout.contains("Usage:"));
        assert!(execution.stdout.contains("doctor"));
    }
}
