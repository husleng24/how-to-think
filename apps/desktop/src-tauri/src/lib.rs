pub mod ai;
pub mod atomic_write;
pub mod cli;
pub mod cli_guard;
pub mod command_service;
pub mod commands;
pub mod desktop_bridge;
pub mod documents;
pub mod errors;
pub mod export_cli;
pub mod file_index;
pub mod fs_watch;
pub mod git_contracts;
pub mod git_service;
pub mod links;
pub mod markdown_lifecycle;
pub mod mindmap_cli;
pub mod models;
pub mod path_guard;
pub mod settings;
pub mod time_utils;
pub mod workspace;

#[cfg(test)]
pub(crate) mod workspace_test_fixtures;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use tauri::Manager;

    let desktop_bridge_state = desktop_bridge::DesktopBridgeState::default();
    let startup_desktop_bridge_state = desktop_bridge_state.clone();

    tauri::Builder::default()
        .setup(move |app| {
            match app.path().app_data_dir() {
                Ok(app_data_dir) => {
                    if let Err(error) =
                        startup_desktop_bridge_state.start(app_data_dir, env!("CARGO_PKG_VERSION"))
                    {
                        eprintln!("Desktop bridge unavailable: {}", error.message);
                    }
                }
                Err(error) => {
                    eprintln!("Desktop bridge app data directory unavailable: {error}");
                }
            }
            Ok(())
        })
        .manage(fs_watch::WorkspaceWatchState::default())
        .manage(desktop_bridge_state)
        .manage(ai::runner::AiRuntimeState::default())
        .invoke_handler(tauri::generate_handler![
            commands::load_remembered_workspace,
            commands::select_workspace_at_path,
            commands::open_workspace_at_path,
            commands::create_workspace_at_path,
            commands::list_workspace_files,
            commands::refresh_workspace_files,
            commands::index_workspace_links,
            commands::resolve_workspace_link,
            commands::resolve_workspace_links,
            commands::start_workspace_change_detection,
            commands::refresh_workspace_external_changes,
            commands::stop_workspace_change_detection,
            commands::check_open_document_external_change,
            commands::parse_markdown_preview,
            commands::open_markdown_mind_map,
            commands::serialize_mind_map,
            commands::save_markdown_mind_map,
            commands::remember_last_opened_file,
            commands::validate_workspace_relative_path,
            commands::publish_desktop_session_status,
            commands::get_desktop_session_status,
            commands::drain_desktop_ui_actions,
            commands::create_markdown_document,
            commands::preview_ai_context_snapshot,
            commands::open_markdown_document,
            commands::save_markdown_document,
            commands::rename_markdown_document,
            commands::delete_markdown_document,
            commands::git_detect_repository,
            commands::git_init_repository,
            commands::git_status,
            commands::git_create_snapshot,
            commands::git_history,
            commands::git_diff,
            ai::providers::list_ai_providers,
            ai::providers::save_ai_provider,
            ai::providers::select_ai_provider,
            ai::providers::remove_ai_provider,
            ai::providers::check_ai_provider_health,
            ai::runner::send_ai_conversation_message,
            ai::runner::cancel_ai_run,
            ai::runner::list_ai_sessions,
        ])
        .run(tauri::generate_context!())
        .expect("error while running How to Think desktop shell");
}
