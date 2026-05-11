use crate::ai::context::{AiContextLimits, AiContextScope, AiContextSnapshot, AiMindMapDocument};
use crate::ai::session::AiConversationLimits;
use crate::ai_cli::{
    AiChatCliRequest, AiContextPreviewCliRequest, AiProposalApplyCliRequest,
    AiProposalValidateCliRequest, AiProviderHealthCliRequest,
};
use crate::command_service::{
    CliErrorCode, CliResultEnvelope, CommandService, CommandServicePaths, DoctorCheckStatus,
    DoctorReport, DoctorRequest, HelpData, MarkdownLinksResolveCliRequest, MarkdownParseCliRequest,
    MarkdownSerializeCliRequest, MindMapCliRequest, UiActionRequest, VersionData,
    WorkspaceFileCreateRequest, WorkspaceFileDeleteRequest, WorkspaceFileOpenRequest,
    WorkspaceFileRenameRequest, WorkspaceFileSaveRequest, WorkspacePathRequest,
};
use crate::desktop_bridge::CliUiActionKind;
use crate::export_cli::{
    normalize_cli_relative_path, parse_render_export_format, parse_render_scope, RenderCliRequest,
    RenderExportFormat, RenderExportScope,
};
use crate::links::model::{LinkKind, LinkReference};
use crate::mindmap_cli::MindMapSiblingPosition;
use crate::models::FileVersion;
use how_to_think_markdown::{
    MarkdownLineEnding, MindMapDocument, ParseMode, SerializePreservationPolicy,
};
use serde_json::Value;
use std::path::PathBuf;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutputMode {
    Human,
    Json,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CliOptions {
    pub command: CliCommand,
    pub output_mode: OutputMode,
    pub workspace_path: Option<PathBuf>,
    pub app_data_dir: Option<PathBuf>,
    pub app_config_dir: Option<PathBuf>,
    pub non_interactive: bool,
    pub target: Option<String>,
    pub reason: Option<String>,
    pub confirmation_token: Option<String>,
    pub relative_path: Option<String>,
    pub new_relative_path: Option<String>,
    pub content: Option<String>,
    pub expected_version: Option<FileVersion>,
    pub parse_mode: ParseMode,
    pub document: Option<MindMapDocument>,
    pub target_path: Option<String>,
    pub preservation_policy: SerializePreservationPolicy,
    pub line_ending: MarkdownLineEnding,
    pub link_target: Option<String>,
    pub link_kind: LinkKind,
    pub link_label: Option<String>,
    pub link_alias: Option<String>,
    pub open_in_desktop: bool,
    pub node_id: Option<String>,
    pub node_path: Option<String>,
    pub parent_id: Option<String>,
    pub parent_path: Option<String>,
    pub text: Option<String>,
    pub title: Option<String>,
    pub root_text: Option<String>,
    pub index: Option<usize>,
    pub position: MindMapSiblingPosition,
    pub child_ids: Vec<String>,
    pub template: Option<String>,
    pub render_format: Option<RenderExportFormat>,
    pub render_output_path: Option<String>,
    pub render_scope: RenderExportScope,
    pub overwrite: bool,
    pub provider_id: Option<String>,
    pub session_id: Option<String>,
    pub prompt: Option<String>,
    pub context: Option<AiContextSnapshot>,
    pub ai_context_scope: Option<AiContextScope>,
    pub ai_document: Option<AiMindMapDocument>,
    pub open_files: Vec<String>,
    pub max_context_bytes: Option<usize>,
    pub max_files: Option<usize>,
    pub max_open_files: Option<usize>,
    pub max_history_messages: Option<usize>,
    pub max_history_bytes: Option<usize>,
    pub content_revision: Option<u64>,
    pub base_document_version: Option<u64>,
    pub proposal: Option<Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CliCommand {
    Help,
    Version,
    Doctor,
    WorkspaceOpen,
    WorkspaceCreate,
    WorkspaceValidate,
    WorkspaceRecentList,
    WorkspaceFilesList,
    WorkspaceFilesRefresh,
    WorkspaceFileCreate,
    WorkspaceFileOpen,
    WorkspaceFileSave,
    WorkspaceFileRename,
    WorkspaceFileDelete,
    MarkdownParse,
    MarkdownCheck,
    MarkdownSerialize,
    MarkdownLinksResolve,
    MindMapRead,
    MindMapCreate,
    MindMapNodeAdd,
    MindMapNodeUpdate,
    MindMapBranchMove,
    MindMapBranchDelete,
    MindMapSiblingsReorder,
    MindMapCollapse,
    MindMapExpand,
    MindMapFocusNode,
    MindMapFitView,
    MindMapDragLayout,
    MindMapHistoryUndo,
    MindMapHistoryRedo,
    Render,
    AiProviderList,
    AiProviderHealth,
    AiContextPreview,
    AiChatSend,
    AiProposalValidate,
    AiProposalApply,
    UiOpen,
    UiFocus,
    UiReview,
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
    let mut target = None;
    let mut reason = None;
    let mut confirmation_token = None;
    let mut relative_path = None;
    let mut new_relative_path = None;
    let mut content = None;
    let mut expected_version = None;
    let mut parse_mode = ParseMode::Auto;
    let mut document = None;
    let mut target_path = None;
    let mut preservation_policy = SerializePreservationPolicy::BlockLossy;
    let mut line_ending = MarkdownLineEnding::Lf;
    let mut link_target = None;
    let mut link_kind = LinkKind::ObsidianWiki;
    let mut link_label = None;
    let mut link_alias = None;
    let mut open_in_desktop = false;
    let mut node_id = None;
    let mut node_path = None;
    let mut parent_id = None;
    let mut parent_path = None;
    let mut text = None;
    let mut title = None;
    let mut root_text = None;
    let mut index_value = None;
    let mut position = MindMapSiblingPosition::After;
    let mut child_ids = Vec::new();
    let mut template = None;
    let mut render_format = None;
    let mut render_output_path = None;
    let mut render_scope = RenderExportScope::CurrentFile;
    let mut overwrite = false;
    let mut provider_id = None;
    let mut session_id = None;
    let mut prompt = None;
    let mut context = None;
    let mut ai_context_scope = None;
    let mut ai_document = None;
    let mut open_files = Vec::new();
    let mut max_context_bytes = None;
    let mut max_files = None;
    let mut max_open_files = None;
    let mut max_history_messages = None;
    let mut max_history_bytes = None;
    let mut content_revision = None;
    let mut base_document_version = None;
    let mut proposal = None;
    let mut command = None;
    let mut index = 0;

    while index < args.len() {
        match args[index].as_str() {
            "--json" => {
                output_mode = OutputMode::Json;
                index += 1;
            }
            "--format" if is_render_command_context(command, args) => {
                let value = required_value(args, index)?;
                render_format =
                    Some(
                        parse_render_export_format(value).map_err(|message| CliParseError {
                            code: CliErrorCode::InvalidOutputFormat,
                            message,
                        })?,
                    );
                index += 2;
            }
            "--output" if is_render_command_context(command, args) => {
                let value = required_value(args, index)?;
                render_output_path = Some(normalize_cli_relative_path(value));
                index += 2;
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
            "--target" => {
                let value = required_value(args, index)?;
                target = Some(value.to_owned());
                index += 2;
            }
            "--reason" => {
                let value = required_value(args, index)?;
                reason = Some(value.to_owned());
                index += 2;
            }
            "--confirm-token" => {
                let value = required_value(args, index)?;
                confirmation_token = Some(value.to_owned());
                index += 2;
            }
            "--path" | "--file" => {
                let value = required_value(args, index)?;
                relative_path = Some(value.to_owned());
                index += 2;
            }
            "--new-path" => {
                let value = required_value(args, index)?;
                new_relative_path = Some(value.to_owned());
                index += 2;
            }
            "--target-path" => {
                let value = required_value(args, index)?;
                target_path = Some(value.to_owned());
                index += 2;
            }
            "--content" | "--markdown" => {
                let value = required_any_value(args, index)?;
                content = Some(value.to_owned());
                index += 2;
            }
            "--expected-version" => {
                let value = required_value(args, index)?;
                expected_version =
                    Some(serde_json::from_str(value).map_err(|error| CliParseError {
                        code: CliErrorCode::InvalidArguments,
                        message: format!(
                            "Flag `--expected-version` must be FileVersion JSON: {error}"
                        ),
                    })?);
                index += 2;
            }
            "--document-json" if is_ai_command_context(command, args) => {
                let value = required_any_value(args, index)?;
                ai_document = Some(serde_json::from_str(value).map_err(|error| CliParseError {
                    code: CliErrorCode::InvalidArguments,
                    message: format!(
                        "Flag `--document-json` must be AI mind map document JSON: {error}"
                    ),
                })?);
                index += 2;
            }
            "--document-json" => {
                let value = required_any_value(args, index)?;
                document = Some(serde_json::from_str(value).map_err(|error| CliParseError {
                    code: CliErrorCode::InvalidArguments,
                    message: format!(
                        "Flag `--document-json` must be MindMapDocument JSON: {error}"
                    ),
                })?);
                index += 2;
            }
            "--ai-document-json" => {
                let value = required_any_value(args, index)?;
                ai_document = Some(serde_json::from_str(value).map_err(|error| CliParseError {
                    code: CliErrorCode::InvalidArguments,
                    message: format!(
                        "Flag `--ai-document-json` must be AI mind map document JSON: {error}"
                    ),
                })?);
                index += 2;
            }
            "--parse-mode" => {
                let value = required_value(args, index)?;
                parse_mode = parse_parse_mode(value)?;
                index += 2;
            }
            "--preservation-policy" => {
                let value = required_value(args, index)?;
                preservation_policy = parse_preservation_policy(value)?;
                index += 2;
            }
            "--line-ending" => {
                let value = required_value(args, index)?;
                line_ending = parse_line_ending(value)?;
                index += 2;
            }
            "--link-target" => {
                let value = required_any_value(args, index)?;
                link_target = Some(value.to_owned());
                index += 2;
            }
            "--link-kind" => {
                let value = required_value(args, index)?;
                link_kind = parse_link_kind(value)?;
                index += 2;
            }
            "--link-label" => {
                let value = required_any_value(args, index)?;
                link_label = Some(value.to_owned());
                index += 2;
            }
            "--link-alias" => {
                let value = required_any_value(args, index)?;
                link_alias = Some(value.to_owned());
                index += 2;
            }
            "--ui" | "--desktop" => {
                open_in_desktop = true;
                index += 1;
            }
            "--node-id" => {
                let value = required_value(args, index)?;
                node_id = Some(value.to_owned());
                index += 2;
            }
            "--node-path" => {
                let value = required_any_value(args, index)?;
                node_path = Some(value.to_owned());
                index += 2;
            }
            "--parent-id" => {
                let value = required_value(args, index)?;
                parent_id = Some(value.to_owned());
                index += 2;
            }
            "--parent-path" => {
                let value = required_any_value(args, index)?;
                parent_path = Some(value.to_owned());
                index += 2;
            }
            "--text" => {
                let value = required_any_value(args, index)?;
                text = Some(value.to_owned());
                index += 2;
            }
            "--title" => {
                let value = required_any_value(args, index)?;
                title = Some(value.to_owned());
                index += 2;
            }
            "--root-text" => {
                let value = required_any_value(args, index)?;
                root_text = Some(value.to_owned());
                index += 2;
            }
            "--index" => {
                let value = required_value(args, index)?;
                index_value = Some(value.parse::<usize>().map_err(|error| CliParseError {
                    code: CliErrorCode::InvalidArguments,
                    message: format!("Flag `--index` must be a non-negative integer: {error}"),
                })?);
                index += 2;
            }
            "--position" => {
                let value = required_value(args, index)?;
                position = parse_mindmap_position(value)?;
                index += 2;
            }
            "--child-ids" | "--children" => {
                let value = required_any_value(args, index)?;
                child_ids = parse_child_ids(value)?;
                index += 2;
            }
            "--template" => {
                let value = required_value(args, index)?;
                template = Some(value.to_owned());
                index += 2;
            }
            "--scope" if is_render_command_context(command, args) => {
                let value = required_value(args, index)?;
                render_scope = parse_render_scope(value).map_err(|message| CliParseError {
                    code: CliErrorCode::InvalidArguments,
                    message,
                })?;
                index += 2;
            }
            "--scope" if is_ai_command_context(command, args) => {
                let value = required_value(args, index)?;
                ai_context_scope = Some(parse_ai_context_scope(value)?);
                index += 2;
            }
            "--scope" => {
                let value = required_value(args, index)?;
                ai_context_scope = Some(parse_ai_context_scope(value)?);
                index += 2;
            }
            "--overwrite" => {
                overwrite = true;
                index += 1;
            }
            "--provider" | "--provider-id" => {
                let value = required_value(args, index)?;
                provider_id = Some(value.to_owned());
                index += 2;
            }
            "--session" | "--session-id" => {
                let value = required_value(args, index)?;
                session_id = Some(value.to_owned());
                index += 2;
            }
            "--prompt" => {
                let value = required_any_value(args, index)?;
                prompt = Some(value.to_owned());
                index += 2;
            }
            "--context-json" => {
                let value = required_any_value(args, index)?;
                context = Some(serde_json::from_str(value).map_err(|error| CliParseError {
                    code: CliErrorCode::InvalidArguments,
                    message: format!(
                        "Flag `--context-json` must be AiContextSnapshot JSON: {error}"
                    ),
                })?);
                index += 2;
            }
            "--proposal-json" => {
                let value = required_any_value(args, index)?;
                proposal = Some(serde_json::from_str(value).map_err(|error| CliParseError {
                    code: CliErrorCode::InvalidArguments,
                    message: format!("Flag `--proposal-json` must be proposal JSON: {error}"),
                })?);
                index += 2;
            }
            "--open-files" => {
                let value = required_any_value(args, index)?;
                open_files = parse_string_list(value)?;
                index += 2;
            }
            "--max-context-bytes" => {
                max_context_bytes = Some(parse_usize_flag(args, index)?);
                index += 2;
            }
            "--max-files" => {
                max_files = Some(parse_usize_flag(args, index)?);
                index += 2;
            }
            "--max-open-files" => {
                max_open_files = Some(parse_usize_flag(args, index)?);
                index += 2;
            }
            "--max-history-messages" => {
                max_history_messages = Some(parse_usize_flag(args, index)?);
                index += 2;
            }
            "--max-history-bytes" => {
                max_history_bytes = Some(parse_usize_flag(args, index)?);
                index += 2;
            }
            "--content-revision" => {
                content_revision = Some(parse_u64_flag(args, index)?);
                index += 2;
            }
            "--base-document-version" => {
                base_document_version = Some(parse_u64_flag(args, index)?);
                index += 2;
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
            value if command == Some(CliCommand::Render) && relative_path.is_none() => {
                relative_path = Some(normalize_cli_relative_path(value));
                index += 1;
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
        target,
        reason,
        confirmation_token,
        relative_path,
        new_relative_path,
        content,
        expected_version,
        parse_mode,
        document,
        target_path,
        preservation_policy,
        line_ending,
        link_target,
        link_kind,
        link_label,
        link_alias,
        open_in_desktop,
        node_id,
        node_path,
        parent_id,
        parent_path,
        text,
        title,
        root_text,
        index: index_value,
        position,
        child_ids,
        template,
        render_format,
        render_output_path,
        render_scope,
        overwrite,
        provider_id,
        session_id,
        prompt,
        context,
        ai_context_scope,
        ai_document,
        open_files,
        max_context_bytes,
        max_files,
        max_open_files,
        max_history_messages,
        max_history_bytes,
        content_revision,
        base_document_version,
        proposal,
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
        CliCommand::WorkspaceOpen
        | CliCommand::WorkspaceCreate
        | CliCommand::WorkspaceValidate
        | CliCommand::WorkspaceRecentList
        | CliCommand::WorkspaceFilesList
        | CliCommand::WorkspaceFilesRefresh
        | CliCommand::WorkspaceFileCreate
        | CliCommand::WorkspaceFileOpen
        | CliCommand::WorkspaceFileSave
        | CliCommand::WorkspaceFileRename
        | CliCommand::WorkspaceFileDelete
        | CliCommand::MarkdownParse
        | CliCommand::MarkdownCheck
        | CliCommand::MarkdownSerialize
        | CliCommand::MarkdownLinksResolve
        | CliCommand::MindMapRead
        | CliCommand::MindMapCreate
        | CliCommand::MindMapNodeAdd
        | CliCommand::MindMapNodeUpdate
        | CliCommand::MindMapBranchMove
        | CliCommand::MindMapBranchDelete
        | CliCommand::MindMapSiblingsReorder
        | CliCommand::MindMapCollapse
        | CliCommand::MindMapExpand
        | CliCommand::MindMapFocusNode
        | CliCommand::MindMapFitView
        | CliCommand::MindMapDragLayout
        | CliCommand::MindMapHistoryUndo
        | CliCommand::MindMapHistoryRedo
        | CliCommand::Render
        | CliCommand::AiProviderList
        | CliCommand::AiProviderHealth
        | CliCommand::AiContextPreview
        | CliCommand::AiChatSend
        | CliCommand::AiProposalValidate
        | CliCommand::AiProposalApply => match CommandServicePaths::resolve(
            options.app_data_dir.clone(),
            options.app_config_dir.clone(),
        ) {
            Ok(paths) => {
                let service = CommandService::new(paths);
                match command_envelope(&service, &options) {
                    Ok(envelope) => render_envelope(envelope, options.output_mode),
                    Err(error) => {
                        let envelope = CliResultEnvelope::error(
                            operation_id(options.command),
                            error.code,
                            error.message,
                        );
                        render_error(envelope, options.output_mode)
                    }
                }
            }
            Err(error) => {
                let envelope = CliResultEnvelope::error(
                    operation_id(options.command),
                    error.code,
                    error.message,
                );
                render_error(envelope, options.output_mode)
            }
        },
        CliCommand::UiOpen | CliCommand::UiFocus | CliCommand::UiReview => {
            match CommandServicePaths::resolve(
                options.app_data_dir.clone(),
                options.app_config_dir.clone(),
            ) {
                Ok(paths) => {
                    let service = CommandService::new(paths);
                    let request = ui_action_request(&options);
                    let envelope = service.request_desktop_ui(request);
                    render_error(envelope, options.output_mode)
                }
                Err(error) => {
                    let envelope = CliResultEnvelope::error(
                        ui_operation_id(options.command),
                        error.code,
                        error.message,
                    );
                    render_error(envelope, options.output_mode)
                }
            }
        }
    }
}

fn command_envelope(
    service: &CommandService,
    options: &CliOptions,
) -> Result<CliResultEnvelope, CliParseError> {
    match options.command {
        CliCommand::WorkspaceOpen => Ok(service.open_workspace(WorkspacePathRequest {
            workspace_path: options.workspace_path.clone(),
            remember: true,
        })),
        CliCommand::WorkspaceCreate => Ok(service.create_workspace(WorkspacePathRequest {
            workspace_path: options.workspace_path.clone(),
            remember: true,
        })),
        CliCommand::WorkspaceValidate => Ok(service.validate_workspace(WorkspacePathRequest {
            workspace_path: options.workspace_path.clone(),
            remember: false,
        })),
        CliCommand::WorkspaceRecentList => Ok(service.list_recent_workspaces()),
        CliCommand::WorkspaceFilesList => {
            Ok(service.list_workspace_files(options.workspace_path.clone()))
        }
        CliCommand::WorkspaceFilesRefresh => {
            Ok(service.refresh_workspace_files(options.workspace_path.clone()))
        }
        CliCommand::WorkspaceFileCreate => {
            Ok(service.create_workspace_file(WorkspaceFileCreateRequest {
                workspace_path: options.workspace_path.clone(),
                relative_path: required_path(options)?,
                content: options.content.clone(),
                confirmation_token: options.confirmation_token.clone(),
                non_interactive: options.non_interactive,
            }))
        }
        CliCommand::WorkspaceFileOpen => {
            Ok(service.open_workspace_file(WorkspaceFileOpenRequest {
                workspace_path: options.workspace_path.clone(),
                relative_path: required_path(options)?,
                open_in_desktop: options.open_in_desktop,
                non_interactive: options.non_interactive,
            }))
        }
        CliCommand::WorkspaceFileSave => {
            Ok(service.save_workspace_file(WorkspaceFileSaveRequest {
                workspace_path: options.workspace_path.clone(),
                relative_path: required_path(options)?,
                content: options
                    .content
                    .clone()
                    .ok_or_else(|| missing_flag("--content"))?,
                expected_version: options
                    .expected_version
                    .clone()
                    .ok_or_else(|| missing_flag("--expected-version"))?,
                confirmation_token: options.confirmation_token.clone(),
                non_interactive: options.non_interactive,
            }))
        }
        CliCommand::WorkspaceFileRename => {
            Ok(service.rename_workspace_file(WorkspaceFileRenameRequest {
                workspace_path: options.workspace_path.clone(),
                relative_path: required_path(options)?,
                new_relative_path: options
                    .new_relative_path
                    .clone()
                    .ok_or_else(|| missing_flag("--new-path"))?,
                expected_version: options.expected_version.clone(),
                confirmation_token: options.confirmation_token.clone(),
                non_interactive: options.non_interactive,
            }))
        }
        CliCommand::WorkspaceFileDelete => {
            Ok(service.delete_workspace_file(WorkspaceFileDeleteRequest {
                workspace_path: options.workspace_path.clone(),
                relative_path: required_path(options)?,
                expected_version: options.expected_version.clone(),
                confirmation_token: options.confirmation_token.clone(),
                non_interactive: options.non_interactive,
            }))
        }
        CliCommand::MarkdownParse => Ok(service.parse_markdown_cli(MarkdownParseCliRequest {
            workspace_path: options.workspace_path.clone(),
            relative_path: options.relative_path.clone(),
            markdown: options.content.clone(),
            parse_mode: options.parse_mode,
        })),
        CliCommand::MarkdownCheck => Ok(service.check_markdown_cli(MarkdownParseCliRequest {
            workspace_path: options.workspace_path.clone(),
            relative_path: options.relative_path.clone(),
            markdown: options.content.clone(),
            parse_mode: options.parse_mode,
        })),
        CliCommand::MarkdownSerialize => {
            Ok(service.serialize_markdown_cli(MarkdownSerializeCliRequest {
                workspace_path: options.workspace_path.clone(),
                relative_path: options.relative_path.clone(),
                markdown: options.content.clone(),
                document: options.document.clone(),
                target_path: options
                    .target_path
                    .clone()
                    .or_else(|| options.new_relative_path.clone()),
                preservation_policy: options.preservation_policy,
                line_ending: options.line_ending,
            }))
        }
        CliCommand::MarkdownLinksResolve => {
            let link = options.link_target.clone().map(|target| LinkReference {
                kind: options.link_kind,
                raw: None,
                label: options.link_label.clone(),
                target,
                alias: options.link_alias.clone(),
            });
            Ok(
                service.resolve_markdown_links_cli(MarkdownLinksResolveCliRequest {
                    workspace_path: options.workspace_path.clone(),
                    source_relative_path: required_path(options)?,
                    link,
                }),
            )
        }
        CliCommand::MindMapRead => Ok(service.read_mindmap_cli(mindmap_request(options)?)),
        CliCommand::MindMapCreate => Ok(service.create_mindmap_cli(mindmap_request(options)?)),
        CliCommand::MindMapNodeAdd => Ok(service.add_mindmap_node_cli(mindmap_request(options)?)),
        CliCommand::MindMapNodeUpdate => {
            Ok(service.update_mindmap_node_cli(mindmap_request(options)?))
        }
        CliCommand::MindMapBranchMove => {
            Ok(service.move_mindmap_branch_cli(mindmap_request(options)?))
        }
        CliCommand::MindMapBranchDelete => {
            Ok(service.delete_mindmap_branch_cli(mindmap_request(options)?))
        }
        CliCommand::MindMapSiblingsReorder => {
            Ok(service.reorder_mindmap_siblings_cli(mindmap_request(options)?))
        }
        CliCommand::MindMapCollapse => {
            Ok(service.unsupported_mindmap_cli_action("mindmap.collapse", "mindmap.collapse"))
        }
        CliCommand::MindMapExpand => {
            Ok(service.unsupported_mindmap_cli_action("mindmap.expand", "mindmap.expand"))
        }
        CliCommand::MindMapHistoryUndo => {
            Ok(service
                .unsupported_mindmap_cli_action("mindmap.history.undo", "mindmap.history.undo"))
        }
        CliCommand::MindMapHistoryRedo => {
            Ok(service
                .unsupported_mindmap_cli_action("mindmap.history.redo", "mindmap.history.redo"))
        }
        CliCommand::MindMapFocusNode
        | CliCommand::MindMapFitView
        | CliCommand::MindMapDragLayout => {
            Ok(service.request_desktop_ui(mindmap_ui_action_request(options)))
        }
        CliCommand::Render => Ok(service.render_cli(render_request(options)?)),
        CliCommand::AiProviderList => Ok(service.list_ai_providers_cli()),
        CliCommand::AiProviderHealth => Ok(service.check_ai_provider_health_cli(
            AiProviderHealthCliRequest {
                provider_id: options.provider_id.clone(),
            },
        )),
        CliCommand::AiContextPreview => {
            Ok(service.preview_ai_context_cli(ai_context_request(options)))
        }
        CliCommand::AiChatSend => Ok(service.send_ai_chat_cli(ai_chat_request(options)?)),
        CliCommand::AiProposalValidate => {
            Ok(service.validate_ai_proposal_cli(ai_proposal_validate_request(options)?))
        }
        CliCommand::AiProposalApply => {
            Ok(service.apply_ai_proposal_cli(ai_proposal_apply_request(options)?))
        }
        _ => Err(CliParseError {
            code: CliErrorCode::CommandUnavailable,
            message: format!(
                "Command `{}` is not available here.",
                operation_id(options.command)
            ),
        }),
    }
}

fn mindmap_request(options: &CliOptions) -> Result<MindMapCliRequest, CliParseError> {
    Ok(MindMapCliRequest {
        workspace_path: options.workspace_path.clone(),
        relative_path: required_path(options)?,
        expected_version: options.expected_version.clone(),
        confirmation_token: options.confirmation_token.clone(),
        non_interactive: options.non_interactive,
        parse_mode: options.parse_mode,
        preservation_policy: options.preservation_policy,
        line_ending: options.line_ending,
        node_id: options.node_id.clone(),
        node_path: options.node_path.clone(),
        parent_id: options.parent_id.clone(),
        parent_path: options.parent_path.clone(),
        text: options.text.clone(),
        title: options.title.clone(),
        root_text: options.root_text.clone(),
        index: options.index,
        position: options.position,
        child_ids: options.child_ids.clone(),
        template: options.template.clone(),
    })
}

fn render_request(options: &CliOptions) -> Result<RenderCliRequest, CliParseError> {
    let source_relative_path = required_path(options)?;
    Ok(RenderCliRequest {
        workspace_path: options.workspace_path.clone(),
        source_relative_path,
        output_relative_path: options.render_output_path.clone(),
        format: options
            .render_format
            .ok_or_else(|| missing_flag("--format"))?,
        scope: options.render_scope,
        node_id: options.node_id.clone(),
        node_path: options.node_path.clone(),
        expected_version: options.expected_version.clone(),
        confirmation_token: options.confirmation_token.clone(),
        non_interactive: options.non_interactive,
        overwrite: options.overwrite,
        parse_mode: options.parse_mode,
        line_ending: options.line_ending,
        preservation_policy: options.preservation_policy,
    })
}

fn ai_context_request(options: &CliOptions) -> AiContextPreviewCliRequest {
    AiContextPreviewCliRequest {
        workspace_path: options.workspace_path.clone(),
        scope: options.ai_context_scope,
        current_file: options.relative_path.clone(),
        open_files: options.open_files.clone(),
        selected_node_id: options.node_id.clone(),
        document: options.ai_document.clone(),
        content_revision: options.content_revision,
        limits: ai_context_limits(options),
    }
}

fn ai_chat_request(options: &CliOptions) -> Result<AiChatCliRequest, CliParseError> {
    let prompt = options
        .prompt
        .clone()
        .or_else(|| options.content.clone())
        .ok_or_else(|| missing_flag("--prompt"))?;
    Ok(AiChatCliRequest {
        workspace_path: options.workspace_path.clone(),
        provider_id: options.provider_id.clone(),
        session_id: options.session_id.clone(),
        prompt,
        context: options.context.clone(),
        context_request: ai_context_request(options),
        limits: ai_conversation_limits(options),
    })
}

fn ai_proposal_validate_request(
    options: &CliOptions,
) -> Result<AiProposalValidateCliRequest, CliParseError> {
    Ok(AiProposalValidateCliRequest {
        workspace_path: options.workspace_path.clone(),
        proposal: required_proposal(options)?,
        base_document_version: options.base_document_version,
        active_file_path: options.relative_path.clone(),
    })
}

fn ai_proposal_apply_request(
    options: &CliOptions,
) -> Result<AiProposalApplyCliRequest, CliParseError> {
    Ok(AiProposalApplyCliRequest {
        workspace_path: options.workspace_path.clone(),
        proposal: required_proposal(options)?,
        base_document_version: options.base_document_version,
        active_file_path: options.relative_path.clone(),
        confirmation_token: options.confirmation_token.clone(),
        non_interactive: options.non_interactive,
    })
}

fn ai_context_limits(options: &CliOptions) -> AiContextLimits {
    let mut limits = AiContextLimits::default();
    if let Some(value) = options.max_context_bytes {
        limits.max_context_bytes = value;
    }
    if let Some(value) = options.max_files {
        limits.max_files = value;
    }
    if let Some(value) = options.max_open_files {
        limits.max_open_files = value;
    }
    limits
}

fn ai_conversation_limits(options: &CliOptions) -> AiConversationLimits {
    let mut limits = AiConversationLimits::default();
    if let Some(value) = options.max_history_messages {
        limits.max_history_messages = value;
    }
    if let Some(value) = options.max_history_bytes {
        limits.max_history_bytes = value;
    }
    limits
}

fn required_proposal(options: &CliOptions) -> Result<Value, CliParseError> {
    if let Some(proposal) = &options.proposal {
        return Ok(proposal.clone());
    }
    let Some(content) = &options.content else {
        return Err(missing_flag("--proposal-json"));
    };
    serde_json::from_str(content).map_err(|error| CliParseError {
        code: CliErrorCode::InvalidArguments,
        message: format!("Flag `--proposal-json` must be proposal JSON: {error}"),
    })
}

fn mindmap_ui_action_request(options: &CliOptions) -> UiActionRequest {
    let command_id = operation_id(options.command).to_owned();
    let kind = match options.command {
        CliCommand::MindMapFocusNode | CliCommand::MindMapFitView => {
            CliUiActionKind::FocusExistingWindow
        }
        CliCommand::MindMapDragLayout => CliUiActionKind::OpenReviewSurface,
        _ => CliUiActionKind::OpenWindow,
    };
    let target = options.target.clone().unwrap_or_else(|| {
        let mut target = String::new();
        if let Some(workspace_path) = &options.workspace_path {
            target.push_str(&format!("workspace:{}", workspace_path.display()));
        } else {
            target.push_str("workspace");
        }
        if let Some(relative_path) = &options.relative_path {
            target.push_str(&format!("/file:{relative_path}"));
        }
        if let Some(node_id) = &options.node_id {
            target.push_str(&format!("/node:{node_id}"));
        } else if let Some(node_path) = &options.node_path {
            target.push_str(&format!("/node-path:{node_path}"));
        }
        target
    });
    let reason = options
        .reason
        .clone()
        .unwrap_or_else(|| match options.command {
            CliCommand::MindMapFocusNode => {
                "Focus the requested mind map node in the desktop UI.".to_owned()
            }
            CliCommand::MindMapFitView => "Fit the mind map view in the desktop UI.".to_owned(),
            CliCommand::MindMapDragLayout => {
                "Manual layout changes require the desktop UI.".to_owned()
            }
            _ => "Open the desktop UI for this mind map action.".to_owned(),
        });

    UiActionRequest {
        command_id,
        kind,
        target,
        reason,
        non_interactive: options.non_interactive,
    }
}

fn render_envelope(envelope: CliResultEnvelope, output_mode: OutputMode) -> CliExecution {
    if !envelope.ok {
        return render_error(envelope, output_mode);
    }

    let exit_code = envelope.exit_code();
    let stdout = match output_mode {
        OutputMode::Human => render_human_envelope_data(&envelope),
        OutputMode::Json => serialize_envelope(&envelope),
    };

    CliExecution {
        stdout,
        stderr: String::new(),
        exit_code,
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
            let message = render_human_error_message(&envelope);

            CliExecution {
                stdout: String::new(),
                stderr: format!("{message}\nRun `how-to-think help` for usage."),
                exit_code,
            }
        }
    }
}

fn render_human_error_message(envelope: &CliResultEnvelope) -> String {
    if let Some(confirmation) = &envelope.needs_confirmation {
        let prompt = confirmation
            .get("prompt")
            .and_then(|value| value.as_str())
            .unwrap_or("This operation requires confirmation.");
        let token = confirmation
            .get("confirm_token")
            .and_then(|value| value.as_str())
            .unwrap_or("<unavailable>");
        return format!("Confirmation required: {prompt}\nConfirmation token: {token}");
    }

    if let Some(action) = &envelope.ui_action {
        let reason = action
            .get("reason")
            .and_then(|value| value.as_str())
            .unwrap_or("The operation must continue in the desktop UI.");
        let target = action
            .get("target")
            .and_then(|value| value.as_str())
            .unwrap_or("app");
        return format!("Desktop UI required: {reason}\nTarget: {target}");
    }

    let message = envelope
        .error
        .as_ref()
        .map(|error| error.message.as_str())
        .unwrap_or("Command failed.");
    format!("Error: {message}")
}

fn render_human_envelope_data(envelope: &CliResultEnvelope) -> String {
    let data = envelope.data.as_ref().unwrap_or(&Value::Null);

    match envelope.operation_id.as_str() {
        "workspace.open" | "workspace.create" => render_workspace_session(data),
        "workspace.validate" => {
            let workspace = &data["workspace"];
            format!(
                "Workspace valid: {}\nMarkdown files: {}\nWritable: {}",
                text(workspace, "displayPath"),
                data["file_count"]
                    .as_u64()
                    .or_else(|| data["fileCount"].as_u64())
                    .unwrap_or_default(),
                data["writable"].as_bool().unwrap_or(false)
            )
        }
        "workspace.recent.list" => {
            let mut output = String::new();
            let remembered = text(data, "rememberedWorkspaceId");
            if !remembered.is_empty() {
                output.push_str(&format!("Remembered workspace: {remembered}\n"));
            }
            output.push_str("Recent workspaces:\n");
            for workspace in data["recentWorkspaces"].as_array().into_iter().flatten() {
                output.push_str(&format!("  {}\n", text(workspace, "displayPath")));
            }
            output
        }
        "workspace.files.list" | "workspace.files.refresh" => render_workspace_files(data),
        "workspace.file.open" => text(data, "content").to_owned(),
        "workspace.file.create" => format!(
            "Created {} ({})",
            text(data, "relativePath"),
            text(&data["version"], "token")
        ),
        "workspace.file.save" => format!(
            "Saved {} ({})",
            text(data, "relativePath"),
            text(&data["version"], "token")
        ),
        "workspace.file.rename" => format!(
            "Renamed {} -> {}",
            text(data, "relativePath"),
            text(data, "newRelativePath")
        ),
        "workspace.file.delete" => format!("Deleted {}", text(data, "relativePath")),
        "markdown.parse" | "markdown.check" => format!(
            "Markdown status: {}\nDiagnostics: {}",
            text(data, "status"),
            data["diagnostics"].as_array().map_or(0, Vec::len)
        ),
        "markdown.serialize" => data["markdown"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| {
                format!(
                    "Serialization status: {}\nDiagnostics: {}",
                    text(data, "status"),
                    data["diagnostics"].as_array().map_or(0, Vec::len)
                )
            }),
        "markdown.links.resolve" => render_link_resolutions(data),
        "mindmap.read" => render_mindmap_read(data),
        "mindmap.create"
        | "mindmap.node.add"
        | "mindmap.node.update"
        | "mindmap.branch.move"
        | "mindmap.branch.delete"
        | "mindmap.siblings.reorder" => render_mindmap_mutation(data),
        "render" => render_export_result(data),
        "ai.provider.list" => render_ai_provider_list(data),
        "ai.provider.health" => render_ai_provider_health(data),
        "ai.context.preview" => render_ai_context_preview(data),
        "ai.chat.send" => render_ai_chat_response(data),
        "ai.proposal.validate" => render_ai_proposal_validation(data),
        _ => serde_json::to_string_pretty(data).expect("CLI data must serialize"),
    }
}

fn render_workspace_session(data: &Value) -> String {
    let workspace = &data["workspace"];
    let file_count = data["files"].as_array().map_or(0, Vec::len);
    format!(
        "Workspace: {}\nMarkdown files: {}",
        text(workspace, "displayPath"),
        file_count
    )
}

fn render_workspace_files(data: &Value) -> String {
    let workspace = &data["workspace"];
    let mut output = format!(
        "Workspace: {}\nMarkdown files:\n",
        text(workspace, "displayPath")
    );
    for file in data["files"].as_array().into_iter().flatten() {
        output.push_str(&format!(
            "  {:<40} {} bytes\n",
            text(file, "relativePath"),
            file["byteSize"].as_u64().unwrap_or_default()
        ));
    }
    output
}

fn render_link_resolutions(data: &Value) -> String {
    let mut output = format!("Source: {}\nLinks:\n", text(data, "sourceRelativePath"));
    for link in data["links"].as_array().into_iter().flatten() {
        output.push_str(&format!(
            "  {:<12} {}\n",
            text(link, "status"),
            text(link, "target")
        ));
    }
    output
}

fn render_mindmap_read(data: &Value) -> String {
    let summary = &data["summary"];
    let selected = &data["selectedNode"];
    let mut output = format!(
        "Mind map: {}\nTitle: {}\nNodes: {}\nDiagnostics: {}",
        text(data, "relativePath"),
        text(summary, "title"),
        summary["contentNodeCount"].as_u64().unwrap_or_default(),
        summary["diagnosticCount"].as_u64().unwrap_or_default()
    );
    if selected.is_object() {
        output.push_str(&format!("\nSelected: {}", text(selected, "title")));
    }
    output
}

fn render_mindmap_mutation(data: &Value) -> String {
    let changed = data["changedNodeIds"].as_array().map_or(0, Vec::len);
    format!(
        "{} {} ({})\nChanged nodes: {}\nDiagnostics: {}",
        text(data, "command"),
        text(data, "affectedFile"),
        text(&data["version"], "token"),
        changed,
        data["diagnostics"].as_array().map_or(0, Vec::len)
    )
}

fn render_export_result(data: &Value) -> String {
    let artifact = &data["artifact"];
    let mut output = format!(
        "Rendered {} to {}\nBytes: {}",
        text(data, "sourceRelativePath"),
        text(data, "outputPath"),
        artifact["byteSize"].as_u64().unwrap_or_default()
    );
    if let (Some(width), Some(height)) = (artifact["width"].as_u64(), artifact["height"].as_u64()) {
        output.push_str(&format!("\nDimensions: {}x{}", width, height));
    }
    if let Some(page_count) = artifact["pageCount"].as_u64() {
        output.push_str(&format!("\nPages: {page_count}"));
    }
    let warning_count = data["warnings"].as_array().map_or(0, Vec::len);
    if warning_count > 0 {
        output.push_str(&format!("\nWarnings: {warning_count}"));
    }
    output
}

fn render_ai_provider_list(data: &Value) -> String {
    let mut output = String::new();
    if let Some(active) = data["activeProviderId"].as_str() {
        output.push_str(&format!("Active provider: {active}\n"));
    }
    output.push_str("AI providers:\n");
    for provider in data["providers"].as_array().into_iter().flatten() {
        output.push_str(&format!(
            "  {:<24} {}{}\n",
            text(provider, "id"),
            text(provider, "displayName"),
            if provider["enabled"].as_bool().unwrap_or(false) {
                ""
            } else {
                " (disabled)"
            }
        ));
    }
    output
}

fn render_ai_provider_health(data: &Value) -> String {
    let status = &data["status"];
    format!(
        "Provider {}: {}\n{}",
        text(data, "providerId"),
        text(status, "status"),
        text(status, "message")
    )
}

fn render_ai_context_preview(data: &Value) -> String {
    format!(
        "AI context: {}\nItems: {}\nBytes: {}\nTokens: {}\nWarnings: {}",
        text(data, "displayLabel"),
        data["items"].as_array().map_or(0, Vec::len),
        data["byteEstimate"].as_u64().unwrap_or_default(),
        data["tokenEstimate"].as_u64().unwrap_or_default(),
        data["warnings"].as_array().map_or(0, Vec::len)
    )
}

fn render_ai_chat_response(data: &Value) -> String {
    data["assistantMessage"]["content"]
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| format!("AI run status: {}", text(&data["run"], "status")))
}

fn render_ai_proposal_validation(data: &Value) -> String {
    if data["validation"]["ok"].as_bool().unwrap_or(false) {
        format!(
            "AI proposal valid\nAffected files: {}\nRisk flags: {}",
            data["affectedFiles"].as_array().map_or(0, Vec::len),
            data["riskFlags"].as_array().map_or(0, Vec::len)
        )
    } else {
        format!(
            "AI proposal invalid\nErrors: {}",
            data["validation"]["errors"].as_array().map_or(0, Vec::len)
        )
    }
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or("")
}

fn ui_action_request(options: &CliOptions) -> UiActionRequest {
    let command_id = ui_operation_id(options.command).to_owned();
    let kind = match options.command {
        CliCommand::UiOpen => CliUiActionKind::OpenWindow,
        CliCommand::UiFocus => CliUiActionKind::FocusExistingWindow,
        CliCommand::UiReview => CliUiActionKind::OpenReviewSurface,
        _ => CliUiActionKind::OpenWindow,
    };
    let target = options
        .target
        .clone()
        .or_else(|| {
            options
                .workspace_path
                .as_ref()
                .map(|path| format!("workspace:{}", path.display()))
        })
        .unwrap_or_else(|| "app".to_owned());
    let reason = options
        .reason
        .clone()
        .unwrap_or_else(|| match options.command {
            CliCommand::UiOpen => "Open the desktop app for this target.".to_owned(),
            CliCommand::UiFocus => "Focus this target in the desktop app.".to_owned(),
            CliCommand::UiReview => "Review this target in the desktop app.".to_owned(),
            _ => "Open the desktop app.".to_owned(),
        });

    UiActionRequest {
        command_id,
        kind,
        target,
        reason,
        non_interactive: options.non_interactive,
    }
}

fn ui_operation_id(command: CliCommand) -> &'static str {
    match command {
        CliCommand::UiOpen => "ui.open",
        CliCommand::UiFocus => "ui.focus",
        CliCommand::UiReview => "ui.review",
        _ => "ui.open",
    }
}

fn operation_id(command: CliCommand) -> &'static str {
    match command {
        CliCommand::Help => "help",
        CliCommand::Version => "version",
        CliCommand::Doctor => "diagnostics.doctor",
        CliCommand::WorkspaceOpen => "workspace.open",
        CliCommand::WorkspaceCreate => "workspace.create",
        CliCommand::WorkspaceValidate => "workspace.validate",
        CliCommand::WorkspaceRecentList => "workspace.recent.list",
        CliCommand::WorkspaceFilesList => "workspace.files.list",
        CliCommand::WorkspaceFilesRefresh => "workspace.files.refresh",
        CliCommand::WorkspaceFileCreate => "workspace.file.create",
        CliCommand::WorkspaceFileOpen => "workspace.file.open",
        CliCommand::WorkspaceFileSave => "workspace.file.save",
        CliCommand::WorkspaceFileRename => "workspace.file.rename",
        CliCommand::WorkspaceFileDelete => "workspace.file.delete",
        CliCommand::MarkdownParse => "markdown.parse",
        CliCommand::MarkdownCheck => "markdown.check",
        CliCommand::MarkdownSerialize => "markdown.serialize",
        CliCommand::MarkdownLinksResolve => "markdown.links.resolve",
        CliCommand::MindMapRead => "mindmap.read",
        CliCommand::MindMapCreate => "mindmap.create",
        CliCommand::MindMapNodeAdd => "mindmap.node.add",
        CliCommand::MindMapNodeUpdate => "mindmap.node.update",
        CliCommand::MindMapBranchMove => "mindmap.branch.move",
        CliCommand::MindMapBranchDelete => "mindmap.branch.delete",
        CliCommand::MindMapSiblingsReorder => "mindmap.siblings.reorder",
        CliCommand::MindMapCollapse => "mindmap.collapse",
        CliCommand::MindMapExpand => "mindmap.expand",
        CliCommand::MindMapFocusNode => "mindmap.focus-node",
        CliCommand::MindMapFitView => "mindmap.fit-view",
        CliCommand::MindMapDragLayout => "mindmap.drag-layout",
        CliCommand::MindMapHistoryUndo => "mindmap.history.undo",
        CliCommand::MindMapHistoryRedo => "mindmap.history.redo",
        CliCommand::Render => "render",
        CliCommand::AiProviderList => "ai.provider.list",
        CliCommand::AiProviderHealth => "ai.provider.health",
        CliCommand::AiContextPreview => "ai.context.preview",
        CliCommand::AiChatSend => "ai.chat.send",
        CliCommand::AiProposalValidate => "ai.proposal.validate",
        CliCommand::AiProposalApply => "ai.proposal.apply",
        CliCommand::UiOpen | CliCommand::UiFocus | CliCommand::UiReview => ui_operation_id(command),
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
    output.push_str("\nExamples:\n");
    output.push_str("  how-to-think render ./ideas.md --format png --output ideas.png\n");
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
    output.push_str(&format!(
        "Desktop bridge: {}{}\n",
        if data.desktop.running {
            "running"
        } else {
            "not running"
        },
        if data.desktop.bridge_available {
            " (reachable)"
        } else {
            ""
        }
    ));

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
        "workspace.open" => Ok(CliCommand::WorkspaceOpen),
        "workspace.create" => Ok(CliCommand::WorkspaceCreate),
        "workspace.validate" => Ok(CliCommand::WorkspaceValidate),
        "workspace.recent.list" => Ok(CliCommand::WorkspaceRecentList),
        "workspace.files.list" => Ok(CliCommand::WorkspaceFilesList),
        "workspace.files.refresh" => Ok(CliCommand::WorkspaceFilesRefresh),
        "workspace.file.create" => Ok(CliCommand::WorkspaceFileCreate),
        "workspace.file.open" | "workspace.file.read" => Ok(CliCommand::WorkspaceFileOpen),
        "workspace.file.save" | "workspace.file.write" => Ok(CliCommand::WorkspaceFileSave),
        "workspace.file.rename" => Ok(CliCommand::WorkspaceFileRename),
        "workspace.file.delete" => Ok(CliCommand::WorkspaceFileDelete),
        "markdown.parse" => Ok(CliCommand::MarkdownParse),
        "markdown.check" => Ok(CliCommand::MarkdownCheck),
        "markdown.serialize" | "markdown.export-preview" => Ok(CliCommand::MarkdownSerialize),
        "markdown.links.resolve" => Ok(CliCommand::MarkdownLinksResolve),
        "mindmap.read" | "mindmap.query" => Ok(CliCommand::MindMapRead),
        "mindmap.create" => Ok(CliCommand::MindMapCreate),
        "mindmap.node.add" | "mindmap.add-child" | "mindmap.add-sibling" => {
            Ok(CliCommand::MindMapNodeAdd)
        }
        "mindmap.node.update" | "mindmap.rename-node" => Ok(CliCommand::MindMapNodeUpdate),
        "mindmap.branch.move" | "mindmap.move-subtree" => Ok(CliCommand::MindMapBranchMove),
        "mindmap.branch.delete" | "mindmap.delete-subtree" => Ok(CliCommand::MindMapBranchDelete),
        "mindmap.siblings.reorder" | "mindmap.reorder-siblings" => {
            Ok(CliCommand::MindMapSiblingsReorder)
        }
        "mindmap.collapse" | "mindmap.collapse-node" => Ok(CliCommand::MindMapCollapse),
        "mindmap.expand" | "mindmap.expand-node" => Ok(CliCommand::MindMapExpand),
        "mindmap.focus-node" => Ok(CliCommand::MindMapFocusNode),
        "mindmap.fit-view" => Ok(CliCommand::MindMapFitView),
        "mindmap.drag-layout" => Ok(CliCommand::MindMapDragLayout),
        "mindmap.history.undo" => Ok(CliCommand::MindMapHistoryUndo),
        "mindmap.history.redo" => Ok(CliCommand::MindMapHistoryRedo),
        "render" | "export.render" => Ok(CliCommand::Render),
        "ai.provider.list" | "ai.providers.list" => Ok(CliCommand::AiProviderList),
        "ai.provider.health" | "ai.provider.check" => Ok(CliCommand::AiProviderHealth),
        "ai.context.preview" | "ai.context" => Ok(CliCommand::AiContextPreview),
        "ai.chat.send" | "ai.ask" | "ai.chat" => Ok(CliCommand::AiChatSend),
        "ai.proposal.validate" => Ok(CliCommand::AiProposalValidate),
        "ai.proposal.apply" => Ok(CliCommand::AiProposalApply),
        "ui.open" => Ok(CliCommand::UiOpen),
        "ui.focus" => Ok(CliCommand::UiFocus),
        "ui.review" => Ok(CliCommand::UiReview),
        _ => Err(CliParseError {
            code: CliErrorCode::CommandUnavailable,
            message: format!("Unknown command `{value}`."),
        }),
    }
}

fn parse_parse_mode(value: &str) -> Result<ParseMode, CliParseError> {
    match value {
        "auto" => Ok(ParseMode::Auto),
        "heading-only" | "heading_only" => Ok(ParseMode::HeadingOnly),
        "list-only" | "list_only" => Ok(ParseMode::ListOnly),
        "mixed" => Ok(ParseMode::Mixed),
        _ => Err(CliParseError {
            code: CliErrorCode::InvalidArguments,
            message: format!("Unsupported parse mode `{value}`."),
        }),
    }
}

fn parse_preservation_policy(value: &str) -> Result<SerializePreservationPolicy, CliParseError> {
    match value {
        "block-lossy" | "block_lossy" => Ok(SerializePreservationPolicy::BlockLossy),
        "require-confirmation" | "require_confirmation" => {
            Ok(SerializePreservationPolicy::RequireConfirmation)
        }
        "allow-lossy" | "allow_lossy" => Ok(SerializePreservationPolicy::AllowLossy),
        _ => Err(CliParseError {
            code: CliErrorCode::InvalidArguments,
            message: format!("Unsupported preservation policy `{value}`."),
        }),
    }
}

fn parse_line_ending(value: &str) -> Result<MarkdownLineEnding, CliParseError> {
    match value {
        "lf" => Ok(MarkdownLineEnding::Lf),
        "crlf" => Ok(MarkdownLineEnding::Crlf),
        _ => Err(CliParseError {
            code: CliErrorCode::InvalidArguments,
            message: format!("Unsupported line ending `{value}`."),
        }),
    }
}

fn parse_link_kind(value: &str) -> Result<LinkKind, CliParseError> {
    match value {
        "standard" | "markdown" | "standard-markdown" | "standard_markdown" => {
            Ok(LinkKind::StandardMarkdown)
        }
        "wiki" | "wikilink" | "obsidian" | "obsidian-wiki" | "obsidian_wiki" => {
            Ok(LinkKind::ObsidianWiki)
        }
        "image" => Ok(LinkKind::Image),
        _ => Err(CliParseError {
            code: CliErrorCode::InvalidArguments,
            message: format!("Unsupported link kind `{value}`."),
        }),
    }
}

fn parse_mindmap_position(value: &str) -> Result<MindMapSiblingPosition, CliParseError> {
    match value {
        "before" => Ok(MindMapSiblingPosition::Before),
        "after" => Ok(MindMapSiblingPosition::After),
        _ => Err(CliParseError {
            code: CliErrorCode::InvalidArguments,
            message: format!("Unsupported mind map sibling position `{value}`."),
        }),
    }
}

fn parse_ai_context_scope(value: &str) -> Result<AiContextScope, CliParseError> {
    match value {
        "selected-node" | "selected_node" | "node" => Ok(AiContextScope::SelectedNode),
        "selected-branch" | "selected_branch" | "branch" => Ok(AiContextScope::SelectedBranch),
        "current-file" | "current_file" | "file" => Ok(AiContextScope::CurrentFile),
        "workspace-summary" | "workspace_summary" | "workspace" => {
            Ok(AiContextScope::WorkspaceSummary)
        }
        _ => Err(CliParseError {
            code: CliErrorCode::InvalidArguments,
            message: format!("Unsupported AI context scope `{value}`."),
        }),
    }
}

fn parse_child_ids(value: &str) -> Result<Vec<String>, CliParseError> {
    let child_ids = value
        .split(',')
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(str::to_owned)
        .collect::<Vec<_>>();
    if child_ids.is_empty() {
        return Err(CliParseError {
            code: CliErrorCode::InvalidArguments,
            message: "Flag `--child-ids` must include at least one node id.".to_owned(),
        });
    }
    Ok(child_ids)
}

fn parse_string_list(value: &str) -> Result<Vec<String>, CliParseError> {
    let values = value
        .split(',')
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(str::to_owned)
        .collect::<Vec<_>>();
    if values.is_empty() {
        return Err(CliParseError {
            code: CliErrorCode::InvalidArguments,
            message: "List flag must include at least one value.".to_owned(),
        });
    }
    Ok(values)
}

fn parse_usize_flag(args: &[String], index: usize) -> Result<usize, CliParseError> {
    let value = required_value(args, index)?;
    value.parse::<usize>().map_err(|error| CliParseError {
        code: CliErrorCode::InvalidArguments,
        message: format!(
            "Flag `{}` must be a non-negative integer: {error}",
            args[index]
        ),
    })
}

fn parse_u64_flag(args: &[String], index: usize) -> Result<u64, CliParseError> {
    let value = required_value(args, index)?;
    value.parse::<u64>().map_err(|error| CliParseError {
        code: CliErrorCode::InvalidArguments,
        message: format!(
            "Flag `{}` must be a non-negative integer: {error}",
            args[index]
        ),
    })
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

fn is_render_command_context(command: Option<CliCommand>, args: &[String]) -> bool {
    command == Some(CliCommand::Render)
        || args
            .iter()
            .any(|arg| matches!(arg.as_str(), "render" | "export.render"))
}

fn is_ai_command_context(command: Option<CliCommand>, args: &[String]) -> bool {
    matches!(
        command,
        Some(
            CliCommand::AiProviderList
                | CliCommand::AiProviderHealth
                | CliCommand::AiContextPreview
                | CliCommand::AiChatSend
                | CliCommand::AiProposalValidate
                | CliCommand::AiProposalApply
        )
    ) || args.iter().any(|arg| {
        matches!(
            arg.as_str(),
            "ai.provider.list"
                | "ai.providers.list"
                | "ai.provider.health"
                | "ai.provider.check"
                | "ai.context.preview"
                | "ai.context"
                | "ai.chat.send"
                | "ai.chat"
                | "ai.ask"
                | "ai.proposal.validate"
                | "ai.proposal.apply"
        )
    })
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

fn required_any_value(args: &[String], index: usize) -> Result<&str, CliParseError> {
    let flag = &args[index];
    args.get(index + 1)
        .map(String::as_str)
        .ok_or_else(|| CliParseError {
            code: CliErrorCode::InvalidArguments,
            message: format!("Flag `{flag}` requires a value."),
        })
}

fn required_path(options: &CliOptions) -> Result<String, CliParseError> {
    options
        .relative_path
        .clone()
        .ok_or_else(|| missing_flag("--path"))
}

fn missing_flag(flag: &str) -> CliParseError {
    CliParseError {
        code: CliErrorCode::InvalidArguments,
        message: format!("Flag `{flag}` is required for this command."),
    }
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

    fn version_json() -> String {
        serde_json::to_string(&FileVersion {
            modified_at: "2026-05-10T00:00:00Z".to_owned(),
            byte_size: 4,
            content_hash: "a".repeat(64),
            token: "token".to_owned(),
        })
        .unwrap()
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
    fn parses_ui_handoff_target_and_reason() {
        let options = parse_args(&args(&[
            "ui.review",
            "--target",
            "workspace:one/file:notes.md",
            "--reason",
            "Review dirty state.",
            "--confirm-token",
            "confirm:test",
        ]))
        .unwrap();

        assert_eq!(options.command, CliCommand::UiReview);
        assert_eq!(
            options.target.as_deref(),
            Some("workspace:one/file:notes.md")
        );
        assert_eq!(options.reason.as_deref(), Some("Review dirty state."));
        assert_eq!(options.confirmation_token.as_deref(), Some("confirm:test"));
    }

    #[test]
    fn parses_workspace_file_save_options_and_markdown_content() {
        let expected_version = version_json();
        let options = parse_args(&args(&[
            "--workspace",
            "notes",
            "workspace.file.save",
            "--path",
            "plan.md",
            "--content",
            "- task",
            "--expected-version",
            &expected_version,
        ]))
        .unwrap();

        assert_eq!(options.command, CliCommand::WorkspaceFileSave);
        assert_eq!(options.relative_path.as_deref(), Some("plan.md"));
        assert_eq!(options.content.as_deref(), Some("- task"));
        assert_eq!(options.expected_version.as_ref().unwrap().token, "token");
    }

    #[test]
    fn parses_markdown_link_resolution_options() {
        let options = parse_args(&args(&[
            "markdown.links.resolve",
            "--path",
            "current.md",
            "--link-target",
            "Topic",
            "--link-kind",
            "wiki",
            "--link-alias",
            "Readable topic",
        ]))
        .unwrap();

        assert_eq!(options.command, CliCommand::MarkdownLinksResolve);
        assert_eq!(options.relative_path.as_deref(), Some("current.md"));
        assert_eq!(options.link_target.as_deref(), Some("Topic"));
        assert_eq!(options.link_kind, LinkKind::ObsidianWiki);
        assert_eq!(options.link_alias.as_deref(), Some("Readable topic"));
    }

    #[test]
    fn parses_mindmap_node_add_options() {
        let expected_version = version_json();
        let options = parse_args(&args(&[
            "mindmap.node.add",
            "--path",
            "plan.md",
            "--parent-path",
            "Plan/Alpha",
            "--text",
            "Detail",
            "--index",
            "0",
            "--expected-version",
            &expected_version,
        ]))
        .unwrap();

        assert_eq!(options.command, CliCommand::MindMapNodeAdd);
        assert_eq!(options.relative_path.as_deref(), Some("plan.md"));
        assert_eq!(options.parent_path.as_deref(), Some("Plan/Alpha"));
        assert_eq!(options.text.as_deref(), Some("Detail"));
        assert_eq!(options.index, Some(0));
        assert_eq!(options.expected_version.as_ref().unwrap().token, "token");
    }

    #[test]
    fn parses_mindmap_reorder_child_ids_and_position() {
        let options = parse_args(&args(&[
            "mindmap.reorder-siblings",
            "--path",
            "plan.md",
            "--parent-id",
            "root",
            "--child-ids",
            "b,a",
            "--position",
            "before",
        ]))
        .unwrap();

        assert_eq!(options.command, CliCommand::MindMapSiblingsReorder);
        assert_eq!(options.parent_id.as_deref(), Some("root"));
        assert_eq!(options.child_ids, vec!["b", "a"]);
        assert_eq!(options.position, MindMapSiblingPosition::Before);
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
