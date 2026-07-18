pub mod commands;
pub mod engine;
pub mod gateway;
pub mod ollama;
pub mod ping;
pub mod session;

use commands::EngineState;
use ollama::OllamaState;
use tokio::sync::Mutex;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .manage(EngineState(Mutex::new(engine::Engine::default())))
        .manage(OllamaState::default())
        .invoke_handler(tauri::generate_handler![
            commands::get_defaults,
            commands::start_monitoring,
            commands::stop_monitoring,
            commands::validate_target,
            commands::export_session,
            commands::import_session,
            commands::save_comparison,
            commands::list_comparisons,
            commands::load_comparison,
            commands::delete_comparison,
            ollama::ollama_status,
            ollama::ollama_pull,
            ollama::ollama_generate,
            ollama::ollama_cancel,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
