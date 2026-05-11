use crate::ai::context::{build_context_snapshot, AiContextSnapshot, AiContextSnapshotRequest};
use crate::atomic_write::write_file_atomically;
use crate::command_service;
use crate::desktop_bridge::{
    CliUiAction, DesktopBridgeState, DesktopSessionStatus, DesktopSessionStatusUpdate,
};
use crate::documents;
use crate::errors::{WorkspaceError, WorkspaceErrorCode, WorkspaceOperation};
use crate::fs_watch::{self, WorkspaceWatchState};
use crate::git_contracts::{
    GitDiffRequest, GitDiffResult, GitHistoryEntry, GitHistoryRequest, GitOperationError,
    GitOperationErrorCode, GitRepositoryState, GitRestoreRequest, GitRestoreResult,
    GitServiceOperation, GitSnapshotRequest, GitSnapshotResult, GitStatusSummary,
};
use crate::git_service;
use crate::links::index::WorkspaceLinkIndex;
use crate::links::model::{
    LinkIndexSnapshot, LinkResolution, ResolveLinkRequest, ResolveLinksRequest,
    ResolveLinksResponse,
};
use crate::links::resolver;
use crate::markdown_lifecycle;
use crate::models::{
    DeleteDocumentResult, DocumentExternalChangeStatus, DocumentSnapshot, ExternalChangeBatch,
    FileVersion, RenameDocumentResult, SaveRequest, SaveResult, WorkspaceFile, WorkspaceRecord,
    WorkspaceSession,
};
use crate::settings::SettingsStore;
use crate::workspace::{
    create_workspace, validate_workspace_root, workspace_session,
    workspace_session_with_last_opened_file,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::State;
use tauri::{AppHandle, Manager};

const EXPORT_CONTRACT_VERSION: &str = "2026-05-11.v1";

#[tauri::command]
pub fn load_remembered_workspace(
    app: AppHandle,
) -> Result<Option<WorkspaceSession>, WorkspaceError> {
    let store = settings_store(&app, WorkspaceOperation::LoadWorkspace)?;
    let Some(record) = store.remembered_workspace_record()? else {
        return Ok(None);
    };
    let last_opened_file = store.last_opened_file(&record.info.id)?;

    workspace_session_with_last_opened_file(&record, last_opened_file).map(Some)
}

#[tauri::command]
pub fn select_workspace_at_path(
    app: AppHandle,
    path: String,
) -> Result<WorkspaceSession, WorkspaceError> {
    open_workspace_at_path(app, path)
}

#[tauri::command]
pub fn open_workspace_at_path(
    app: AppHandle,
    path: String,
) -> Result<WorkspaceSession, WorkspaceError> {
    let record = validate_workspace_root(path, WorkspaceOperation::SelectWorkspace)?;
    let store = settings_store(&app, WorkspaceOperation::SelectWorkspace)?;
    store.remember_workspace(&record)?;
    let last_opened_file = store.last_opened_file(&record.info.id)?;
    workspace_session_with_last_opened_file(&record, last_opened_file)
}

#[tauri::command]
pub fn create_workspace_at_path(
    app: AppHandle,
    path: String,
) -> Result<WorkspaceSession, WorkspaceError> {
    let record = create_workspace(path)?;
    let session = workspace_session(&record)?;
    settings_store(&app, WorkspaceOperation::CreateWorkspace)?.remember_workspace(&record)?;
    Ok(session)
}

#[tauri::command]
pub fn list_workspace_files(
    app: AppHandle,
    workspace_id: String,
) -> Result<Vec<WorkspaceFile>, WorkspaceError> {
    let store = settings_store(&app, WorkspaceOperation::ListFiles)?;
    let workspace_path =
        store.workspace_path_for_id(&workspace_id, WorkspaceOperation::ListFiles)?;
    let record = validate_workspace_root(workspace_path, WorkspaceOperation::ListFiles)?;

    if record.info.id != workspace_id {
        return Err(WorkspaceError::new(
            WorkspaceErrorCode::WorkspaceNotSelected,
            WorkspaceOperation::ListFiles,
            "The requested workspace id does not match the stored workspace path.",
            true,
        ));
    }

    workspace_session(&record).map(|session| session.files)
}

#[tauri::command]
pub fn refresh_workspace_files(
    app: AppHandle,
    workspace_id: String,
) -> Result<Vec<WorkspaceFile>, WorkspaceError> {
    list_workspace_files(app, workspace_id)
}

#[tauri::command]
pub fn index_workspace_links(
    app: AppHandle,
    workspace_id: String,
) -> Result<LinkIndexSnapshot, WorkspaceError> {
    let record = workspace_record_for_id(&app, &workspace_id, WorkspaceOperation::ListFiles)?;
    WorkspaceLinkIndex::from_record(&record).map(|index| index.snapshot())
}

#[tauri::command]
pub fn resolve_workspace_link(
    app: AppHandle,
    request: ResolveLinkRequest,
) -> Result<LinkResolution, WorkspaceError> {
    let record =
        workspace_record_for_id(&app, &request.workspace_id, WorkspaceOperation::OpenFile)?;
    let index = WorkspaceLinkIndex::from_record(&record)?;

    Ok(resolver::resolve_link(
        &index,
        &request.source_relative_path,
        request.link,
    ))
}

#[tauri::command]
pub fn resolve_workspace_links(
    app: AppHandle,
    request: ResolveLinksRequest,
) -> Result<ResolveLinksResponse, WorkspaceError> {
    let record =
        workspace_record_for_id(&app, &request.workspace_id, WorkspaceOperation::OpenFile)?;
    let index = WorkspaceLinkIndex::from_record(&record)?;

    Ok(resolver::resolve_links(
        &index,
        &request.source_relative_path,
        request.links,
    ))
}

#[tauri::command]
pub fn start_workspace_change_detection(
    app: AppHandle,
    workspace_id: String,
) -> Result<ExternalChangeBatch, WorkspaceError> {
    let record = workspace_record_for_id(&app, &workspace_id, WorkspaceOperation::WatchWorkspace)?;
    app.state::<WorkspaceWatchState>()
        .start(app.clone(), record)
}

#[tauri::command]
pub fn refresh_workspace_external_changes(
    app: AppHandle,
    workspace_id: String,
) -> Result<ExternalChangeBatch, WorkspaceError> {
    let record = workspace_record_for_id(&app, &workspace_id, WorkspaceOperation::WatchWorkspace)?;
    app.state::<WorkspaceWatchState>().refresh(record)
}

#[tauri::command]
pub fn stop_workspace_change_detection(
    app: AppHandle,
    workspace_id: String,
) -> Result<(), WorkspaceError> {
    app.state::<WorkspaceWatchState>().stop(&workspace_id)
}

#[tauri::command]
pub fn check_open_document_external_change(
    app: AppHandle,
    workspace_id: String,
    relative_path: String,
    expected_version: FileVersion,
) -> Result<DocumentExternalChangeStatus, WorkspaceError> {
    let record = workspace_record_for_id(&app, &workspace_id, WorkspaceOperation::WatchWorkspace)?;
    fs_watch::document_external_change_status(&record, &relative_path, &expected_version)
}

#[tauri::command(rename = "parseMarkdownPreview")]
pub fn parse_markdown_preview(
    request: markdown_lifecycle::ParseMarkdownPreviewRequest,
) -> markdown_lifecycle::ParseMarkdownPreviewResult {
    markdown_lifecycle::parse_markdown_preview(request)
}

#[tauri::command(rename = "openMarkdownMindMap")]
pub fn open_markdown_mind_map(
    app: AppHandle,
    request: markdown_lifecycle::OpenMarkdownMindMapRequest,
) -> Result<markdown_lifecycle::OpenMarkdownMindMapResult, WorkspaceError> {
    let record =
        workspace_record_for_id(&app, &request.workspace_id, WorkspaceOperation::OpenFile)?;
    markdown_lifecycle::open_markdown_mind_map(&record, request)
}

#[tauri::command(rename = "serializeMindMap")]
pub fn serialize_mind_map(
    request: markdown_lifecycle::SerializeMindMapRequest,
) -> markdown_lifecycle::SerializeMindMapResult {
    markdown_lifecycle::serialize_mind_map(request)
}

#[tauri::command(rename = "saveMarkdownMindMap")]
pub fn save_markdown_mind_map(
    app: AppHandle,
    request: markdown_lifecycle::SaveMarkdownMindMapRequest,
) -> Result<markdown_lifecycle::SaveMarkdownMindMapResult, WorkspaceError> {
    let record =
        workspace_record_for_id(&app, &request.workspace_id, WorkspaceOperation::SaveFile)?;
    markdown_lifecycle::save_markdown_mind_map(&record, request)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopExportArtifact {
    data: Vec<u8>,
    mime_type: String,
    byte_size: Option<u64>,
    width: Option<f64>,
    height: Option<f64>,
    page_count: Option<u64>,
    rendered_node_count: Option<u64>,
    rendered_edge_count: Option<u64>,
    #[serde(default)]
    warnings: Vec<ExportWarningPayload>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExportWarningPayload {
    code: String,
    message: String,
    severity: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    details: Option<Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResultPayload {
    ok: bool,
    contract_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    format: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    output_path: Option<String>,
    warnings: Vec<ExportWarningPayload>,
    #[serde(skip_serializing_if = "Option::is_none")]
    artifact: Option<ExportArtifactMetadataPayload>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<ExportErrorPayload>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportArtifactMetadataPayload {
    mime_type: String,
    byte_size: Option<u64>,
    width: Option<f64>,
    height: Option<f64>,
    page_count: Option<u64>,
    checksum_sha256: Option<String>,
    rendered_node_count: Option<u64>,
    rendered_edge_count: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportErrorPayload {
    code: String,
    message: String,
    recoverable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    details: Option<Value>,
}

struct ResolvedExportPath {
    absolute_path: PathBuf,
    display_path: String,
}

#[tauri::command(rename = "exportMindMap")]
pub fn export_mind_map(
    app: AppHandle,
    request: Value,
    artifact: DesktopExportArtifact,
) -> ExportResultPayload {
    let mut failure_warnings = request_warnings(&request);
    failure_warnings.extend(artifact.warnings.clone());

    match write_desktop_export_artifact(&app, &request, artifact) {
        Ok(result) => result,
        Err(error) => export_failure_result(&request, failure_warnings, error),
    }
}

#[tauri::command]
pub fn create_markdown_document(
    app: AppHandle,
    workspace_id: String,
    relative_path: String,
    content: Option<String>,
) -> Result<DocumentSnapshot, WorkspaceError> {
    let record = workspace_record_for_id(&app, &workspace_id, WorkspaceOperation::CreateFile)?;
    documents::create_document(&record, &relative_path, content)
}

#[tauri::command]
pub fn open_markdown_document(
    app: AppHandle,
    workspace_id: String,
    relative_path: String,
) -> Result<DocumentSnapshot, WorkspaceError> {
    let record = workspace_record_for_id(&app, &workspace_id, WorkspaceOperation::OpenFile)?;
    documents::open_document(&record, &relative_path)
}

#[tauri::command]
pub fn save_markdown_document(
    app: AppHandle,
    request: SaveRequest,
) -> Result<SaveResult, WorkspaceError> {
    let record =
        workspace_record_for_id(&app, &request.workspace_id, WorkspaceOperation::SaveFile)?;
    documents::save_document(&record, request)
}

#[tauri::command]
pub fn rename_markdown_document(
    app: AppHandle,
    workspace_id: String,
    relative_path: String,
    new_relative_path: String,
    expected_version: Option<FileVersion>,
) -> Result<RenameDocumentResult, WorkspaceError> {
    let record = workspace_record_for_id(&app, &workspace_id, WorkspaceOperation::RenameFile)?;
    let result = documents::rename_document(
        &record,
        &relative_path,
        &new_relative_path,
        expected_version,
    )?;
    settings_store(&app, WorkspaceOperation::RenameFile)?.rename_last_opened_file(
        &workspace_id,
        &result.relative_path,
        &result.new_relative_path,
        record.info.case_sensitive,
    )?;
    Ok(result)
}

#[tauri::command]
pub fn delete_markdown_document(
    app: AppHandle,
    workspace_id: String,
    relative_path: String,
    expected_version: Option<FileVersion>,
) -> Result<DeleteDocumentResult, WorkspaceError> {
    let record = workspace_record_for_id(&app, &workspace_id, WorkspaceOperation::DeleteFile)?;
    let result = documents::delete_document(&record, &relative_path, expected_version)?;
    settings_store(&app, WorkspaceOperation::DeleteFile)?.clear_last_opened_file(
        &workspace_id,
        &result.relative_path,
        record.info.case_sensitive,
    )?;
    Ok(result)
}

#[tauri::command]
pub fn remember_last_opened_file(
    app: AppHandle,
    workspace_id: String,
    relative_path: String,
) -> Result<(), WorkspaceError> {
    let store = settings_store(&app, WorkspaceOperation::OpenFile)?;
    let workspace_path =
        store.workspace_path_for_id(&workspace_id, WorkspaceOperation::OpenFile)?;
    let record = validate_workspace_root(workspace_path, WorkspaceOperation::OpenFile)?;

    if record.info.id != workspace_id {
        return Err(WorkspaceError::new(
            WorkspaceErrorCode::WorkspaceNotSelected,
            WorkspaceOperation::OpenFile,
            "The requested workspace id does not match the stored workspace path.",
            true,
        ));
    }

    store.remember_last_opened_file(&workspace_id, &relative_path, record.info.case_sensitive)
}

#[tauri::command]
pub fn validate_workspace_relative_path(relative_path: String) -> Result<String, WorkspaceError> {
    command_service::validate_workspace_relative_path(&relative_path)
}

#[tauri::command]
pub fn publish_desktop_session_status(
    state: State<'_, DesktopBridgeState>,
    status: DesktopSessionStatusUpdate,
) -> Result<DesktopSessionStatus, String> {
    state.update_status(status).map_err(|error| error.message)
}

#[tauri::command]
pub fn get_desktop_session_status(state: State<'_, DesktopBridgeState>) -> DesktopSessionStatus {
    state.status()
}

#[tauri::command]
pub fn drain_desktop_ui_actions(state: State<'_, DesktopBridgeState>) -> Vec<CliUiAction> {
    state.drain_pending_ui_actions()
}

#[tauri::command]
pub fn preview_ai_context_snapshot(
    app: AppHandle,
    request: AiContextSnapshotRequest,
) -> Result<AiContextSnapshot, WorkspaceError> {
    let record = workspace_record_for_id(
        &app,
        &request.workspace_id,
        WorkspaceOperation::BuildAiContext,
    )?;
    build_context_snapshot(&record, request)
}

#[tauri::command]
pub fn git_detect_repository(
    app: AppHandle,
    workspace_id: String,
) -> Result<GitRepositoryState, GitOperationError> {
    let record = workspace_record_for_id(&app, &workspace_id, WorkspaceOperation::ListFiles)
        .map_err(|error| workspace_error_to_git_error(GitServiceOperation::Detect, error))?;
    git_service::detect_repository(&record)
}

#[tauri::command]
pub fn git_init_repository(
    app: AppHandle,
    workspace_id: String,
) -> Result<GitRepositoryState, GitOperationError> {
    let record = workspace_record_for_id(&app, &workspace_id, WorkspaceOperation::ListFiles)
        .map_err(|error| workspace_error_to_git_error(GitServiceOperation::Init, error))?;
    git_service::enable_git_for_workspace(&record)
}

#[tauri::command]
pub fn git_status(
    app: AppHandle,
    workspace_id: String,
) -> Result<GitStatusSummary, GitOperationError> {
    let record = workspace_record_for_id(&app, &workspace_id, WorkspaceOperation::ListFiles)
        .map_err(|error| workspace_error_to_git_error(GitServiceOperation::Status, error))?;
    git_service::get_git_status(&record)
}

#[tauri::command]
pub fn git_refresh(
    app: AppHandle,
    workspace_id: String,
) -> Result<GitStatusSummary, GitOperationError> {
    let record = workspace_record_for_id(&app, &workspace_id, WorkspaceOperation::ListFiles)
        .map_err(|error| workspace_error_to_git_error(GitServiceOperation::Refresh, error))?;
    git_service::refresh_git_state(&record)
}

#[tauri::command]
pub fn refresh_git_state(
    app: AppHandle,
    workspace_id: String,
) -> Result<GitStatusSummary, GitOperationError> {
    git_refresh(app, workspace_id)
}

#[tauri::command]
pub fn git_create_snapshot(
    app: AppHandle,
    request: GitSnapshotRequest,
) -> Result<GitSnapshotResult, GitOperationError> {
    let record = workspace_record_for_id(&app, &request.workspace_id, WorkspaceOperation::SaveFile)
        .map_err(|error| workspace_error_to_git_error(GitServiceOperation::Snapshot, error))?;
    git_service::create_snapshot(&record, request)
}

#[tauri::command]
pub fn git_history(
    app: AppHandle,
    request: GitHistoryRequest,
) -> Result<Vec<GitHistoryEntry>, GitOperationError> {
    let record =
        workspace_record_for_id(&app, &request.workspace_id, WorkspaceOperation::ListFiles)
            .map_err(|error| workspace_error_to_git_error(GitServiceOperation::History, error))?;
    git_service::list_git_history(&record, request)
}

#[tauri::command]
pub fn git_diff(
    app: AppHandle,
    request: GitDiffRequest,
) -> Result<GitDiffResult, GitOperationError> {
    let record =
        workspace_record_for_id(&app, &request.workspace_id, WorkspaceOperation::ListFiles)
            .map_err(|error| workspace_error_to_git_error(GitServiceOperation::Diff, error))?;
    git_service::get_git_diff(&record, request)
}

#[tauri::command]
pub fn git_restore_file(
    app: AppHandle,
    request: GitRestoreRequest,
) -> Result<GitRestoreResult, GitOperationError> {
    let record = workspace_record_for_id(&app, &request.workspace_id, WorkspaceOperation::SaveFile)
        .map_err(|error| workspace_error_to_git_error(GitServiceOperation::Restore, error))?;
    git_service::restore_git_file(&record, request)
}

fn write_desktop_export_artifact(
    app: &AppHandle,
    request: &Value,
    artifact: DesktopExportArtifact,
) -> Result<ExportResultPayload, ExportErrorPayload> {
    validate_export_contract(request)?;
    let format = request_format(request)
        .filter(|format| is_export_format(format))
        .ok_or_else(|| {
            export_error(
                "unsupported_export_format",
                "Export format is not supported.",
                true,
                Some(json!({ "format": request.get("format").cloned().unwrap_or(Value::Null) })),
            )
        })?;
    let output_path = request_output_path(request).ok_or_else(|| {
        export_error(
            "missing_output_path",
            "Export output path is required.",
            true,
            Some(json!({ "field": "options.outputPath" })),
        )
    })?;
    let overwrite_policy = request_overwrite_policy(request).ok_or_else(|| {
        export_error(
            "invalid_overwrite_policy",
            "Export overwrite policy is invalid.",
            true,
            Some(json!({ "field": "options.overwritePolicy" })),
        )
    })?;

    validate_artifact_for_format(&artifact, format)?;

    let resolved = resolve_export_output_path(app, request, output_path, format)?;
    let display_path = resolved.display_path.clone();
    let existed = prepare_export_output(&resolved.absolute_path, overwrite_policy)?;
    write_file_atomically(&resolved.absolute_path, &artifact.data).map_err(|error| {
        export_error(
            if error.kind() == std::io::ErrorKind::PermissionDenied {
                "output_not_writable"
            } else {
                "write_failed"
            },
            "Export output write failed.",
            true,
            Some(json!({
                "outputPath": &display_path,
                "reason": error.to_string(),
            })),
        )
    })?;

    let metadata = fs::metadata(&resolved.absolute_path).ok();
    let mut warnings = request_warnings(request);
    warnings.extend(artifact.warnings);
    if existed {
        warnings.push(ExportWarningPayload {
            code: "output_overwrite_requested".to_owned(),
            message: "Existing export artifact was replaced.".to_owned(),
            severity: "warning".to_owned(),
            details: Some(json!({ "outputPath": &display_path })),
        });
    }

    Ok(ExportResultPayload {
        ok: true,
        contract_version: EXPORT_CONTRACT_VERSION.to_owned(),
        format: Some(format.to_owned()),
        output_path: Some(display_path),
        warnings: unique_export_warnings(warnings),
        artifact: Some(ExportArtifactMetadataPayload {
            mime_type: artifact.mime_type,
            byte_size: metadata
                .map(|metadata| metadata.len())
                .or(artifact.byte_size)
                .or(Some(artifact.data.len() as u64)),
            width: artifact.width,
            height: artifact.height,
            page_count: artifact.page_count,
            checksum_sha256: Some(checksum_sha256(&artifact.data)),
            rendered_node_count: artifact.rendered_node_count,
            rendered_edge_count: artifact.rendered_edge_count,
        }),
        error: None,
    })
}

fn validate_export_contract(request: &Value) -> Result<(), ExportErrorPayload> {
    match request
        .get("contractVersion")
        .and_then(Value::as_str)
        .filter(|version| *version == EXPORT_CONTRACT_VERSION)
    {
        Some(_) => Ok(()),
        None => Err(export_error(
            "unsupported_contract_version",
            "Unsupported export contract version.",
            true,
            Some(json!({
                "expected": EXPORT_CONTRACT_VERSION,
                "actual": request.get("contractVersion").cloned().unwrap_or(Value::Null),
            })),
        )),
    }
}

fn validate_artifact_for_format(
    artifact: &DesktopExportArtifact,
    format: &str,
) -> Result<(), ExportErrorPayload> {
    let expected_mime_type = export_mime_type_for_format(format);
    if artifact.mime_type != expected_mime_type {
        return Err(export_error(
            "incompatible_export_options",
            "Prepared export artifact MIME type does not match the requested format.",
            true,
            Some(json!({
                "format": format,
                "expectedMimeType": expected_mime_type,
                "actualMimeType": &artifact.mime_type,
            })),
        ));
    }

    Ok(())
}

fn resolve_export_output_path(
    app: &AppHandle,
    request: &Value,
    output_path: &str,
    format: &str,
) -> Result<ResolvedExportPath, ExportErrorPayload> {
    validate_export_extension(output_path, format)?;
    let trimmed = output_path.trim();
    let candidate = Path::new(trimmed);

    if candidate.is_absolute() {
        return Ok(ResolvedExportPath {
            absolute_path: candidate.to_path_buf(),
            display_path: candidate.display().to_string(),
        });
    }

    let relative_path = validate_export_relative_path(trimmed)?;
    if let Some(workspace_id) = request_workspace_id(request) {
        let record = workspace_record_for_id(app, workspace_id, WorkspaceOperation::SaveFile)
            .map_err(|error| {
                export_error(
                    "output_not_writable",
                    "The selected workspace is unavailable for this export path.",
                    true,
                    Some(json!({
                        "workspaceId": workspace_id,
                        "reason": error.to_string(),
                    })),
                )
            })?;
        let absolute_path = record
            .canonical_root
            .join(relative_path.split('/').collect::<PathBuf>());

        return Ok(ResolvedExportPath {
            absolute_path,
            display_path: record
                .canonical_root
                .join(relative_path.split('/').collect::<PathBuf>())
                .display()
                .to_string(),
        });
    }

    let current_dir = std::env::current_dir().map_err(|error| {
        export_error(
            "output_not_writable",
            "The current working directory is unavailable for this export path.",
            true,
            Some(json!({ "reason": error.to_string() })),
        )
    })?;

    Ok(ResolvedExportPath {
        absolute_path: current_dir.join(relative_path.split('/').collect::<PathBuf>()),
        display_path: current_dir
            .join(relative_path.split('/').collect::<PathBuf>())
            .display()
            .to_string(),
    })
}

fn prepare_export_output(
    absolute_path: &Path,
    overwrite_policy: &str,
) -> Result<bool, ExportErrorPayload> {
    let parent = absolute_path.parent().ok_or_else(|| {
        export_error(
            "output_not_writable",
            "Export output path must include a parent directory.",
            true,
            Some(json!({ "outputPath": absolute_path.display().to_string() })),
        )
    })?;
    let parent_metadata = fs::metadata(parent).map_err(|error| {
        export_error(
            "output_not_writable",
            "Export output parent directory does not exist.",
            true,
            Some(json!({
                "outputPath": absolute_path.display().to_string(),
                "parentDirectory": parent.display().to_string(),
                "reason": error.to_string(),
            })),
        )
    })?;

    if !parent_metadata.is_dir() {
        return Err(export_error(
            "output_not_writable",
            "Export output parent path is not a directory.",
            true,
            Some(json!({
                "outputPath": absolute_path.display().to_string(),
                "parentDirectory": parent.display().to_string(),
            })),
        ));
    }

    let target_metadata = match fs::metadata(absolute_path) {
        Ok(metadata) => Some(metadata),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => {
            return Err(export_error(
                "output_not_writable",
                "Export output path could not be checked.",
                true,
                Some(json!({
                    "outputPath": absolute_path.display().to_string(),
                    "reason": error.to_string(),
                })),
            ))
        }
    };

    if target_metadata
        .as_ref()
        .map(|metadata| metadata.is_dir())
        .unwrap_or(false)
    {
        return Err(export_error(
            "output_path_conflict",
            "Export output path is a directory.",
            true,
            Some(json!({ "outputPath": absolute_path.display().to_string() })),
        ));
    }

    if target_metadata.is_some() && overwrite_policy == "fail_if_exists" {
        return Err(export_error(
            "output_path_conflict",
            "Export output path already exists.",
            true,
            Some(json!({
                "outputPath": absolute_path.display().to_string(),
                "overwritePolicy": overwrite_policy,
            })),
        ));
    }

    Ok(target_metadata.is_some())
}

fn validate_export_relative_path(relative_path: &str) -> Result<String, ExportErrorPayload> {
    if relative_path.is_empty() {
        return Err(invalid_export_output_path(
            relative_path,
            "Workspace-relative export paths cannot be empty.",
        ));
    }

    if relative_path.starts_with("//")
        || relative_path.starts_with('/')
        || has_windows_drive_prefix(relative_path)
        || relative_path.contains('\\')
        || relative_path.chars().any(char::is_control)
    {
        return Err(invalid_export_output_path(
            relative_path,
            "Workspace-relative export paths must use safe forward-slash paths.",
        ));
    }

    for segment in relative_path.split('/') {
        if segment.is_empty()
            || matches!(segment, "." | "..")
            || is_windows_reserved_segment(segment)
        {
            return Err(invalid_export_output_path(
                relative_path,
                "Workspace-relative export paths cannot contain empty, dot, or reserved segments.",
            ));
        }
    }

    Ok(relative_path.to_owned())
}

fn validate_export_extension(output_path: &str, format: &str) -> Result<(), ExportErrorPayload> {
    let normalized = output_path.trim().replace('\\', "/").to_ascii_lowercase();
    let expected_extension = export_extension_for_format(format);

    let extension_matches = if format == "markdown" {
        normalized.ends_with(".md") || normalized.ends_with(".markdown")
    } else {
        normalized.ends_with(expected_extension)
    };

    if !extension_matches {
        return Err(export_error(
            "incompatible_export_options",
            "Output path extension must match the requested export format.",
            true,
            Some(json!({
                "outputPath": output_path,
                "expectedExtension": expected_extension,
                "format": format,
            })),
        ));
    }

    Ok(())
}

fn invalid_export_output_path(path: &str, message: &str) -> ExportErrorPayload {
    export_error(
        "output_not_writable",
        message,
        true,
        Some(json!({ "outputPath": path })),
    )
}

fn request_format(request: &Value) -> Option<&str> {
    request.get("format").and_then(Value::as_str)
}

fn request_output_path(request: &Value) -> Option<&str> {
    request
        .get("options")
        .and_then(|options| options.get("outputPath"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|path| !path.is_empty())
}

fn request_overwrite_policy(request: &Value) -> Option<&str> {
    request
        .get("options")
        .and_then(|options| options.get("overwritePolicy"))
        .and_then(Value::as_str)
        .filter(|policy| matches!(*policy, "fail_if_exists" | "replace_existing"))
}

fn request_workspace_id(request: &Value) -> Option<&str> {
    request
        .get("source")
        .and_then(|source| source.get("workspaceId"))
        .and_then(Value::as_str)
        .filter(|workspace_id| !workspace_id.is_empty())
}

fn request_warnings(request: &Value) -> Vec<ExportWarningPayload> {
    request
        .get("snapshot")
        .and_then(|snapshot| snapshot.get("warnings"))
        .cloned()
        .and_then(|warnings| serde_json::from_value(warnings).ok())
        .unwrap_or_default()
}

fn export_failure_result(
    request: &Value,
    warnings: Vec<ExportWarningPayload>,
    error: ExportErrorPayload,
) -> ExportResultPayload {
    ExportResultPayload {
        ok: false,
        contract_version: EXPORT_CONTRACT_VERSION.to_owned(),
        format: request_format(request)
            .filter(|format| is_export_format(format))
            .map(str::to_owned),
        output_path: request_output_path(request).map(str::to_owned),
        warnings: unique_export_warnings(warnings),
        artifact: None,
        error: Some(error),
    }
}

fn export_error(
    code: impl Into<String>,
    message: impl Into<String>,
    recoverable: bool,
    details: Option<Value>,
) -> ExportErrorPayload {
    ExportErrorPayload {
        code: code.into(),
        message: message.into(),
        recoverable,
        details,
    }
}

fn unique_export_warnings(warnings: Vec<ExportWarningPayload>) -> Vec<ExportWarningPayload> {
    let mut seen = HashSet::new();
    let mut result = Vec::new();

    for warning in warnings {
        let key = format!(
            "{}:{}:{}",
            warning.code,
            warning.message,
            warning
                .details
                .as_ref()
                .map(|details| details.to_string())
                .unwrap_or_default()
        );
        if seen.insert(key) {
            result.push(warning);
        }
    }

    result
}

fn checksum_sha256(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    format!("{:x}", hasher.finalize())
}

fn is_export_format(format: &str) -> bool {
    matches!(format, "svg" | "png" | "pdf" | "markdown")
}

fn export_mime_type_for_format(format: &str) -> &'static str {
    match format {
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "pdf" => "application/pdf",
        "markdown" => "text/markdown",
        _ => "application/octet-stream",
    }
}

fn export_extension_for_format(format: &str) -> &'static str {
    match format {
        "svg" => ".svg",
        "png" => ".png",
        "pdf" => ".pdf",
        "markdown" => ".md",
        _ => "",
    }
}

fn has_windows_drive_prefix(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic()
}

fn is_windows_reserved_segment(segment: &str) -> bool {
    if !cfg!(target_os = "windows") {
        return false;
    }

    let stem = segment
        .split_once('.')
        .map(|(stem, _)| stem)
        .unwrap_or(segment)
        .trim_end_matches(|character| character == ' ' || character == '.');
    let stem = stem.to_ascii_uppercase();

    matches!(
        stem.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    )
}

fn settings_store(
    app: &AppHandle,
    operation: WorkspaceOperation,
) -> Result<SettingsStore, WorkspaceError> {
    let settings_dir = app.path().app_data_dir().map_err(|error| {
        WorkspaceError::new(
            WorkspaceErrorCode::UnknownIoError,
            operation,
            "The app data directory is unavailable.",
            true,
        )
        .with_detail("source", error.to_string())
    })?;

    Ok(command_service::workspace_settings_store(settings_dir))
}

fn workspace_record_for_id(
    app: &AppHandle,
    workspace_id: &str,
    operation: WorkspaceOperation,
) -> Result<WorkspaceRecord, WorkspaceError> {
    let store = settings_store(app, operation)?;
    let workspace_path = store.workspace_path_for_id(workspace_id, operation)?;
    let record = validate_workspace_root(workspace_path, operation)?;

    if record.info.id != workspace_id {
        return Err(WorkspaceError::new(
            WorkspaceErrorCode::WorkspaceNotSelected,
            operation,
            "The requested workspace id does not match the stored workspace path.",
            true,
        ));
    }

    Ok(record)
}

fn workspace_error_to_git_error(
    operation: GitServiceOperation,
    error: WorkspaceError,
) -> GitOperationError {
    let code = match error.code {
        WorkspaceErrorCode::WorkspaceNotSelected | WorkspaceErrorCode::WorkspaceMissing => {
            GitOperationErrorCode::NotRepository
        }
        WorkspaceErrorCode::PermissionDenied | WorkspaceErrorCode::WorkspaceUnwritable => {
            GitOperationErrorCode::PermissionDenied
        }
        WorkspaceErrorCode::InvalidWorkspacePath | WorkspaceErrorCode::WorkspaceNotDirectory => {
            GitOperationErrorCode::RepositoryCorrupt
        }
        _ => GitOperationErrorCode::UnknownGitError,
    };

    GitOperationError::new(code, operation, error.message, error.recoverable)
}
