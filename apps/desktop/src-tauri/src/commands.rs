use crate::ai::context::{build_context_snapshot, AiContextSnapshot, AiContextSnapshotRequest};
use crate::command_service;
use crate::desktop_bridge::{
    CliUiAction, DesktopBridgeState, DesktopSessionStatus, DesktopSessionStatusUpdate,
};
use crate::documents;
use crate::errors::{WorkspaceError, WorkspaceErrorCode, WorkspaceOperation};
use crate::fs_watch::{self, WorkspaceWatchState};
use crate::git_contracts::{
    GitOperationError, GitOperationErrorCode, GitRepositoryState, GitServiceOperation,
    GitSnapshotRequest, GitSnapshotResult, GitStatusSummary,
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
use tauri::State;
use tauri::{AppHandle, Manager};

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
pub fn git_create_snapshot(
    app: AppHandle,
    request: GitSnapshotRequest,
) -> Result<GitSnapshotResult, GitOperationError> {
    let record = workspace_record_for_id(&app, &request.workspace_id, WorkspaceOperation::SaveFile)
        .map_err(|error| workspace_error_to_git_error(GitServiceOperation::Snapshot, error))?;
    git_service::create_snapshot(&record, request)
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
