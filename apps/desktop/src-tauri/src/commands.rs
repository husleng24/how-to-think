use crate::errors::{WorkspaceError, WorkspaceErrorCode, WorkspaceOperation};
use crate::models::{Platform, WorkspaceFile, WorkspaceSession};
use crate::path_guard;
use crate::settings::SettingsStore;
use crate::workspace::{
    create_workspace, validate_workspace_root, workspace_session,
    workspace_session_with_last_opened_file,
};
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
pub fn remember_last_opened_file(
    app: AppHandle,
    workspace_id: String,
    relative_path: String,
) -> Result<(), WorkspaceError> {
    let store = settings_store(&app, WorkspaceOperation::OpenFile)?;
    let workspace_path = store.workspace_path_for_id(&workspace_id, WorkspaceOperation::OpenFile)?;
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
pub fn validate_workspace_relative_path(
    relative_path: String,
) -> Result<String, WorkspaceError> {
    path_guard::validate_workspace_relative_path(
        &relative_path,
        Platform::current().default_case_sensitive(),
        WorkspaceOperation::OpenFile,
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

    Ok(SettingsStore::new(
        settings_dir.join("workspace-settings.json"),
    ))
}
