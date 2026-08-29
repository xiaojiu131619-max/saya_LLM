mod commands;
mod models;
mod services;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent,
};

#[tauri::command]
fn show_main_window(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// 真正退出：先停止 llama-server，再退出进程。
fn quit_app(app: &tauri::AppHandle) {
    eprintln!("[app] quit requested, stopping server...");
    let _ = services::process_manager::stop_server();
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let (app_state, pending_api_key_migration) = commands::config::init_config();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
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
            commands::server::start_server,
            commands::server::stop_server,
            commands::server::get_server_status,
            commands::server::get_server_api_key,
            commands::server::get_lan_ip_address,
            commands::server::get_video_runtime_info,
            commands::server::ping_local_api,
            commands::server::get_server_logs,
            commands::server::clear_server_logs,
            commands::server::get_system_logs,
            commands::server::clear_system_logs,
            commands::server::log_app_event,
            commands::system::get_system_status,
            commands::system::check_engine_info,
            commands::system::read_file_content,
            commands::system::read_media_file,
            commands::system::reveal_path,
            commands::system::open_external_url,
            commands::system::check_video_runtime,
            commands::system::get_system_appearance,
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
            commands::config::set_proxy_url,
            commands::config::save_model_run_record,
            commands::config::get_model_run_records,
            commands::config::clear_model_run_records,
            commands::config::reset_app_config,
            commands::config::get_app_data_dir,
            commands::config::set_close_to_tray,
            commands::benchmark::start_benchmark,
            commands::benchmark::start_auto_tune,
            commands::updater::check_for_update,
            commands::updater::list_recent_releases,
            commands::updater::download_and_update,
            commands::updater::cancel_kernel_update,
            commands::updater::list_installed_kernels,
            commands::updater::list_version_backups,
            commands::updater::rollback_to_version,
            commands::updater::get_update_history,
            show_main_window,
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

            // 系统托盘：关窗后常驻后台，左键单击恢复窗口，右键菜单提供"显示/退出"。
            let show_item = MenuItem::with_id(app, "show", "显示窗口", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出 Agent LLM", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;
            // 托盘图标直接复用应用默认窗口图标（来自 bundle.icon 配置）。
            let icon = app.default_window_icon().cloned();
            let mut tray_builder = TrayIconBuilder::with_id("main-tray")
                .tooltip("Agent LLM")
                .menu(&menu)
                .show_menu_on_left_click(false);
            if let Some(icon) = icon {
                tray_builder = tray_builder.icon(icon);
            }
            tray_builder
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                    }
                })
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => quit_app(app),
                    _ => {}
                })
                .build(app)?;

            eprintln!("[perf] app setup done in {:?}", t0.elapsed());
            Ok(())
        })
        .on_window_event(|window, event| {
            match event {
                // 关闭按钮：根据 close_to_tray 配置决定是隐藏到托盘还是真正退出。
                WindowEvent::CloseRequested { api, .. } => {
                    if window.label() == "main" {
                        let app = window.app_handle();
                        let state = app.state::<models::app_state::AppState>();
                        let close_to_tray =
                            state.config.lock().map(|c| c.close_to_tray).unwrap_or(true);
                        if close_to_tray {
                            api.prevent_close();
                            let _ = window.hide();
                        } else {
                            // 直接退出：停止服务并关闭窗口。
                            eprintln!("[app] close_to_tray disabled, quitting...");
                            let _ = services::process_manager::stop_server();
                            // 允许窗口正常关闭，之后进程会退出。
                        }
                    }
                }
                WindowEvent::Destroyed => {
                    if window.label() == "main" {
                        eprintln!("[app] window destroyed, stopping server...");
                        let _ = services::process_manager::stop_server();
                    }
                }
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
