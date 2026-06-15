// AuraCap: トレイ常駐の画面キャプチャツール / Tray-resident screen capture tool

mod bridge;
mod capture;
mod editor;
mod history;
mod pin;
mod redact;
mod settings;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, RunEvent, WindowEvent};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

/// フロントエンドのエラーをターミナルへ転送する / Forward frontend errors to the terminal
#[tauri::command]
fn frontend_log(message: String) {
    eprintln!("[auracap:frontend] {message}");
}

#[tauri::command]
fn open_history_dir(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = history::history_dir(&app).map_err(|e| e.to_string())?;
    app.opener()
        .open_path(dir.to_string_lossy(), None::<&str>)
        .map_err(|e| e.to_string())
}

/// 設定のホットキーを登録し直す。失敗したキーの説明文を返す（空 = 全成功）
/// Re-register hotkeys from settings; returns failure descriptions (empty = all OK)
fn apply_hotkeys(app: &AppHandle, settings: &settings::Settings) -> Vec<String> {
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    // ホットキー無効時は一切登録しない（他アプリとの競合を完全回避）
    // When disabled, register nothing (fully avoids conflicts with other apps)
    if !settings.hotkeys_enabled {
        return Vec::new();
    }
    let mut errors = Vec::new();
    for (name, keys) in [
        ("矩形", &settings.hotkey_region),
        ("ウィンドウ", &settings.hotkey_window),
        ("全画面", &settings.hotkey_fullscreen),
    ] {
        if keys.is_empty() {
            continue;
        }
        match gs.register(keys.as_str()) {
            Ok(()) => eprintln!("[auracap] registered shortcut: {keys} ({name})"),
            // 他アプリが掴んでいる・重複・不正キーなど / Owned by another app, duplicate, invalid, etc.
            Err(e) => {
                eprintln!("[auracap] failed to register shortcut {keys}: {e}");
                errors.push(format!("{name}（{keys}）"));
            }
        }
    }
    errors
}

// ---- 設定コマンド / Settings commands ----

#[tauri::command]
fn get_settings(state: tauri::State<'_, settings::SettingsState>) -> settings::Settings {
    state.0.lock().unwrap().clone()
}

/// 設定を保存し、ホットキーをベストエフォートで適用する。
/// 保存は常に成功させ、登録できなかったキーの一覧（警告）を返す。
/// 他アプリにキーを掴まれていても設定保存自体は失敗させない。
/// Persist settings and apply hotkeys best-effort. The save always succeeds;
/// returns the list of keys that could not be registered (warnings). A key held
/// by another app must not block saving (e.g. API key / provider changes).
#[tauri::command]
fn save_settings(app: AppHandle, settings: settings::Settings) -> Result<Vec<String>, String> {
    settings::save(&app, &settings)?;
    let warnings = apply_hotkeys(&app, &settings);
    *app.state::<settings::SettingsState>().0.lock().unwrap() = settings;
    Ok(warnings)
}

/// キー入力の録取中はグローバルホットキーを一時停止する（録取中の誤発火防止）
/// Suspend global hotkeys while the UI is recording a key combo
#[tauri::command]
fn suspend_hotkeys(app: AppHandle) {
    let _ = app.global_shortcut().unregister_all();
}

#[tauri::command]
fn resume_hotkeys(app: AppHandle) {
    let current = app.state::<settings::SettingsState>().0.lock().unwrap().clone();
    let _ = apply_hotkeys(&app, &current);
}

// ---- 自動起動（ログオン時） / Auto-launch at login ----

#[tauri::command]
fn get_autostart(app: AppHandle) -> bool {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().unwrap_or(false)
}

#[tauri::command]
fn set_autostart(app: AppHandle, enabled: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    let manager = app.autolaunch();
    if enabled {
        manager.enable().map_err(|e| e.to_string())
    } else {
        manager.disable().map_err(|e| e.to_string())
    }
}

fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let capture_region = MenuItem::with_id(app, "capture_region", "矩形キャプチャ", true, None::<&str>)?;
    let capture_window = MenuItem::with_id(app, "capture_window", "ウィンドウキャプチャ", true, None::<&str>)?;
    let capture_fullscreen = MenuItem::with_id(app, "capture_fullscreen", "全画面キャプチャ", true, None::<&str>)?;
    let open_history = MenuItem::with_id(app, "open_history", "履歴フォルダを開く", true, None::<&str>)?;
    let show_main = MenuItem::with_id(app, "show_main", "AuraCapを表示", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "終了", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &capture_region,
            &capture_window,
            &capture_fullscreen,
            &PredefinedMenuItem::separator(app)?,
            &open_history,
            &show_main,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;

    TrayIconBuilder::with_id("auracap-tray")
        .icon(app.default_window_icon().unwrap().clone())
        .tooltip("AuraCap — PrintScreenで領域キャプチャ")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "quit" => app.exit(0),
            "capture_region" => capture::start_capture(app.clone(), "region".into(), None),
            "capture_window" => capture::start_capture(app.clone(), "window".into(), None),
            "capture_fullscreen" => capture::start_capture(app.clone(), "fullscreen".into(), None),
            "open_history" => {
                let _ = open_history_dir(app.clone());
            }
            "show_main" => show_main_window(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // 左クリックでメインウィンドウを表示 / Left click shows the main window
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

pub(crate) fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 非表示WebViewのバックグラウンド抑制を無効化する。
    // 常駐オーバーレイ（ADR 0002）は隠れたままセッションイベントを受け取る必要がある。
    // Disable hidden-webview background throttling: resident overlays (ADR 0002)
    // must keep processing session events while hidden.
    if std::env::var_os("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").is_none() {
        std::env::set_var(
            "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
            "--disable-renderer-backgrounding --disable-backgrounding-occluded-windows --disable-background-timer-throttling --disable-features=CalculateNativeWinOcclusion",
        );
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // ログオン時の自動起動。引数なしで通常起動（トレイ常駐）
        // Auto-launch at login; no args (starts normally and lives in the tray)
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(capture::SessionState::default())
        .manage(capture::UiInitiated::default())
        .manage(editor::EditorImage::default())
        .manage(pin::PinState::default())
        // 凍結フレーム（無圧縮BMP）をメモリから直接WebViewへ配信する
        // Serve frozen frames (uncompressed BMP) to the webview straight from memory
        .register_uri_scheme_protocol("freeze", |ctx, request| {
            let app = ctx.app_handle();
            let body: Option<Vec<u8>> = request
                .uri()
                .path()
                .trim_start_matches('/')
                .parse::<u32>()
                .ok()
                .and_then(|id| {
                    let state = app.state::<capture::SessionState>();
                    let guard = state.0.lock().unwrap();
                    guard.get(&id).map(|frame| frame.bmp.clone())
                });
            match body {
                Some(bytes) => tauri::http::Response::builder()
                    .header("Content-Type", "image/bmp")
                    .header("Cache-Control", "no-store")
                    .body(bytes)
                    .unwrap(),
                None => tauri::http::Response::builder()
                    .status(404)
                    .body(Vec::new())
                    .unwrap(),
            }
        })
        // 編集対象画像を配信する。CORSヘッダはcanvasの汚染（taint）回避に必要
        // Serve the image being edited; CORS header keeps the canvas untainted
        .register_uri_scheme_protocol("edit", |ctx, _request| {
            let app = ctx.app_handle();
            let body: Option<Vec<u8>> = app
                .state::<editor::EditorImage>()
                .0
                .lock()
                .unwrap()
                .clone();
            match body {
                Some(bytes) => tauri::http::Response::builder()
                    .header("Content-Type", "image/bmp")
                    .header("Cache-Control", "no-store")
                    .header("Access-Control-Allow-Origin", "*")
                    .body(bytes)
                    .unwrap(),
                None => tauri::http::Response::builder()
                    .status(404)
                    .header("Access-Control-Allow-Origin", "*")
                    .body(Vec::new())
                    .unwrap(),
            }
        })
        // 付箋（ピン留め）画像をidごとに配信する / Serve pinned images by id
        .register_uri_scheme_protocol("pin", |ctx, request| {
            let app = ctx.app_handle();
            let body: Option<Vec<u8>> = request
                .uri()
                .path()
                .trim_start_matches('/')
                .parse::<u32>()
                .ok()
                .and_then(|id| {
                    app.state::<pin::PinState>()
                        .images
                        .lock()
                        .unwrap()
                        .get(&id)
                        .cloned()
                });
            match body {
                Some(bytes) => tauri::http::Response::builder()
                    .header("Content-Type", "image/png")
                    .header("Cache-Control", "no-store")
                    .body(bytes)
                    .unwrap(),
                None => tauri::http::Response::builder()
                    .status(404)
                    .body(Vec::new())
                    .unwrap(),
            }
        })
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    eprintln!("[auracap] shortcut event: {shortcut:?} state={:?}", event.state());
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    // 設定された文字列と突き合わせて該当モードを起動する
                    // Match against the configured hotkey strings
                    let current = app.state::<settings::SettingsState>().0.lock().unwrap().clone();
                    let matches =
                        |keys: &str| keys.parse::<Shortcut>().is_ok_and(|s| s == *shortcut);
                    if matches(&current.hotkey_region) {
                        capture::start_overlay_capture(app, capture::CaptureMode::Region);
                    } else if matches(&current.hotkey_window) {
                        capture::start_overlay_capture(app, capture::CaptureMode::Window);
                    } else if matches(&current.hotkey_fullscreen) {
                        capture::capture_fullscreen(app);
                    }
                })
                .build(),
        )
        .setup(|app| {
            // 設定を読み込んでからホットキーを登録する / Load settings, then register hotkeys
            let loaded = settings::load(app.handle());
            app.manage(settings::SettingsState(std::sync::Mutex::new(loaded.clone())));
            apply_hotkeys(app.handle(), &loaded);
            setup_tray(app.handle())?;
            // オーバーレイとエディタを事前生成して隠し常駐させる（切り替え高速化）
            // Pre-create hidden overlays and the editor so switching is fast
            capture::pre_create_overlays(app.handle());
            editor::pre_create_editor(app.handle());
            // ブラウザ拡張からのフルページキャプチャ受信ブリッジ
            // Local bridge that receives full-page captures from the browser extension
            bridge::start(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            capture::get_overlay_info,
            capture::finish_region_capture,
            capture::cancel_capture,
            capture::start_capture,
            capture::overlay_ready,
            editor::editor_ready,
            editor::close_editor,
            editor::editor_has_image,
            editor::export_copy,
            editor::export_save,
            redact::detect_sensitive,
            redact::extract_text,
            pin::pin_image,
            pin::edit_pin,
            open_history_dir,
            get_settings,
            save_settings,
            suspend_hotkeys,
            resume_hotkeys,
            get_autostart,
            set_autostart,
            frontend_log
        ])
        .on_window_event(|window, event| {
            // メイン・エディタは閉じても破棄せず隠すだけ（常駐・使い回し）
            // Main & editor windows hide on close instead of being destroyed (resident reuse)
            match window.label() {
                "main" => {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        let app = window.app_handle();
                        // 設定に応じて：トレイ常駐（隠す）か、アプリ終了か
                        // Per setting: hide to tray, or quit the app
                        let close_to_tray = app
                            .try_state::<settings::SettingsState>()
                            .map(|s| s.0.lock().unwrap().close_to_tray)
                            .unwrap_or(true);
                        if close_to_tray {
                            api.prevent_close();
                            let _ = window.hide();
                        } else {
                            app.exit(0);
                        }
                    }
                }
                "editor" => {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        editor::hide_editor(window.app_handle());
                    }
                }
                // 付箋は閉じたら破棄（使い捨て）。状態だけ掃除する
                // Pins are disposable: let them close, just clean up the stored image
                label if label.starts_with("pin-") => {
                    if let WindowEvent::CloseRequested { .. } = event {
                        pin::forget(window.app_handle(), label);
                    }
                }
                _ => {}
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            // 全ウィンドウが閉じてもプロセスは生かす（トレイ常駐）
            // Keep the process alive when all windows are closed (tray resident)
            if let RunEvent::ExitRequested { api, code, .. } = event {
                if code.is_none() {
                    api.prevent_exit();
                }
            }
        });
}
