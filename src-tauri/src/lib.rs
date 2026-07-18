pub mod commands;
pub mod engine;
pub mod gateway;
pub mod ping;
pub mod session;

use commands::EngineState;
use tokio::sync::Mutex;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(EngineState(Mutex::new(engine::Engine::default())))
        .invoke_handler(tauri::generate_handler![
            commands::get_defaults,
            commands::start_monitoring,
            commands::stop_monitoring,
            commands::validate_target,
            commands::export_session,
            commands::import_session,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
