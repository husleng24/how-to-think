pub mod commands;
pub mod errors;
pub mod file_index;
pub mod models;
pub mod path_guard;
pub mod settings;
pub mod time_utils;
pub mod workspace;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            commands::load_remembered_workspace,
            commands::select_workspace_at_path,
            commands::open_workspace_at_path,
            commands::create_workspace_at_path,
            commands::list_workspace_files,
            commands::refresh_workspace_files,
            commands::remember_last_opened_file,
            commands::validate_workspace_relative_path,
        ])
        .run(tauri::generate_context!())
        .expect("error while running How to Think desktop shell");
}
