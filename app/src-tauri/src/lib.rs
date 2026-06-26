mod commands;
mod models;
mod services;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let (app_state, pending_api_key_migration) = commands::config::init_config();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![
            commands::model::scan_models,
            commands::model::scan_fast,
            commands::model::clear_model_cache,
            commands::model::load_model_from_path,
            commands::model::download_model_file,
            commands::hardware::get_hardware_info,
            commands::hardware::list_gpus,
            commands::hardware::set_gpu_device,
            commands::image::get_image_api_key_status,
            commands::image::save_image_api_key,
            commands::image::delete_image_api_key,
            commands::image::clear_all_image_keys,
            commands::image::generate_image,
            commands::server::start_server,
            commands::server::stop_server,
            commands::server::get_server_status,
            commands::server::get_server_logs,
            commands::server::clear_server_logs,
            commands::system::get_system_status,
            commands::system::check_engine_info,
            commands::system::read_file_content,
            commands::system::reveal_path,
            commands::system::open_external_url,
            commands::config::get_config,
            commands::config::save_config,
            commands::config::get_external_api_key_for_session,
            commands::config::get_external_api_key_status,
            commands::config::create_external_api_key,
            commands::config::delete_external_api_key,
            commands::config::add_model_dir,
            commands::config::remove_model_dir,
            commands::config::save_model_preset,
            commands::config::delete_model_preset,
            commands::config::save_tune_result,
            commands::config::reset_app_config,
            commands::config::get_app_data_dir,
            commands::benchmark::start_benchmark,
            commands::benchmark::start_auto_tune,
            commands::updater::check_for_update,
            commands::updater::list_recent_releases,
            commands::updater::download_and_update,
            commands::updater::list_version_backups,
            commands::updater::rollback_to_version,
            commands::updater::get_update_history,
        ])
        .setup(move |app| {
            let t0 = std::time::Instant::now();
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            // 历史明文 api_key 的 keyring 迁移放到后台线程，避免在窗口出现前同步访问凭据管理器。
            if let Some(plaintext_key) = pending_api_key_migration {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let state = handle.state::<models::app_state::AppState>();
                    commands::config::migrate_plaintext_api_key(&state, plaintext_key);
                });
            }
            eprintln!("[perf] app setup done in {:?}", t0.elapsed());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if window.label() == "main" {
                    eprintln!("[app] window destroyed, stopping server...");
                    let _ = services::process_manager::stop_server();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
