// AuraCap: トレイ常駐の画面キャプチャツール / Tray-resident screen capture tool

mod capture;
mod history;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, RunEvent, WindowEvent};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, ShortcutState};

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

/// デフォルトホットキーを登録する / Register the default hotkeys
/// 領域=PrintScreen, ウィンドウ=Ctrl+PrintScreen, 全画面=Shift+PrintScreen
fn register_shortcuts(app: &AppHandle) {
    for keys in ["PrintScreen", "Ctrl+PrintScreen", "Shift+PrintScreen"] {
        match app.global_shortcut().register(keys) {
            Ok(()) => eprintln!("[auracap] registered shortcut: {keys}"),
            // 他アプリが既に掴んでいる場合でも起動は続行する
            // Keep running even if another app already owns the key
            Err(e) => eprintln!("[auracap] failed to register shortcut {keys}: {e}"),
        }
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
            "capture_region" => capture::start_capture(app.clone(), "region".into()),
            "capture_window" => capture::start_capture(app.clone(), "window".into()),
            "capture_fullscreen" => capture::start_capture(app.clone(), "fullscreen".into()),
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
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(capture::SessionState::default())
        .manage(capture::UiInitiated::default())
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
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    eprintln!("[auracap] shortcut event: {shortcut:?} state={:?}", event.state());
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    if shortcut.matches(Modifiers::empty(), Code::PrintScreen) {
                        capture::start_overlay_capture(app, capture::CaptureMode::Region);
                    } else if shortcut.matches(Modifiers::CONTROL, Code::PrintScreen) {
                        capture::start_overlay_capture(app, capture::CaptureMode::Window);
                    } else if shortcut.matches(Modifiers::SHIFT, Code::PrintScreen) {
                        capture::capture_fullscreen(app);
                    }
                })
                .build(),
        )
        .setup(|app| {
            register_shortcuts(app.handle());
            setup_tray(app.handle())?;
            // オーバーレイを事前生成して隠し常駐させる（キャプチャ切り替え高速化）
            // Pre-create hidden overlays so capture switching is fast
            capture::pre_create_overlays(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            capture::get_overlay_info,
            capture::finish_region_capture,
            capture::cancel_capture,
            capture::start_capture,
            capture::overlay_ready,
            open_history_dir,
            frontend_log
        ])
        .on_window_event(|window, event| {
            // メインウィンドウは閉じても終了せずトレイに常駐する
            // Closing the main window hides it; the app stays resident in the tray
            if window.label() == "main" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
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
