// 軽量エディタ：撮影直後に開く編集ウィンドウの管理と書き出し
// Quick editor: manages the post-capture editing window and exports

use std::io::Cursor;
use std::sync::Mutex;
use std::time::Duration;

use tauri::ipc::InvokeBody;
use tauri::{
    AppHandle, Emitter, EventTarget, Manager, PhysicalSize, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_dialog::DialogExt;
use xcap::image::{ImageFormat, RgbaImage};

type AnyError = Box<dyn std::error::Error>;

/// 編集対象の画像（表示用の無圧縮BMP。edit://で配信する）
/// The image being edited (uncompressed BMP for display, served via edit://)
#[derive(Default)]
pub struct EditorImage(pub Mutex<Option<Vec<u8>>>);

/// 撮影結果をエディタで開く / Open a capture result in the editor
pub fn open_editor(app: &AppHandle, image: &RgbaImage) {
    let mut bmp = Vec::with_capacity((image.width() * image.height() * 4 + 64) as usize);
    if let Err(e) = image.write_to(&mut Cursor::new(&mut bmp), ImageFormat::Bmp) {
        eprintln!("[auracap] editor bmp encode failed: {e}");
        return;
    }
    if let Some(state) = app.try_state::<EditorImage>() {
        *state.0.lock().unwrap() = Some(bmp);
    }

    let (img_w, img_h) = (image.width(), image.height());
    let app = app.clone();
    let _ = app.clone().run_on_main_thread(move || {
        let window = match app.get_webview_window("editor") {
            Some(w) => w,
            None => match create_editor_window(&app) {
                Ok(w) => w,
                Err(e) => {
                    eprintln!("[auracap] failed to create editor window: {e}");
                    return;
                }
            },
        };

        // 画像＋ツールバーが収まるサイズへ。モニターの85%でクランプ（物理px）
        // Fit the image + toolbar, clamped to 85% of the monitor (physical px)
        if let Ok(Some(monitor)) = window.current_monitor() {
            let scale = monitor.scale_factor();
            let toolbar = (96.0 * scale) as u32;
            let min_w = (560.0 * scale) as u32;
            let max_w = (monitor.size().width as f64 * 0.85) as u32;
            let max_h = (monitor.size().height as f64 * 0.85) as u32;
            let w = (img_w + 32).clamp(min_w, max_w.max(min_w));
            let h = (img_h + toolbar).min(max_h);
            let _ = window.set_size(PhysicalSize::new(w, h));
            let _ = window.center();
        }

        let _ = app.emit_to(EventTarget::labeled("editor"), "edit-start", ());

        // 表示はeditor_ready（画像描画準備完了）待ち。2.5秒で強制表示する保険つき
        // Showing waits for editor_ready (image painted); 2.5s fallback force-show
        let app_fallback = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(2500));
            // すでに閉じられている（編集対象が破棄済み）なら何もしない。
            // これがないと「開いてすぐ閉じた」エディタを空のまま再表示してしまう。
            // Skip if the editor was already closed (image dropped); otherwise this
            // would re-show an editor the user just closed, with no image in it.
            let still_open = app_fallback
                .try_state::<EditorImage>()
                .is_some_and(|s| s.0.lock().unwrap().is_some());
            if !still_open {
                return;
            }
            if let Some(w) = app_fallback.get_webview_window("editor") {
                if !w.is_visible().unwrap_or(true) {
                    eprintln!("[auracap] editor not ready after 2.5s, showing anyway");
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
        });
    });
}

/// 起動時にエディタを事前生成して隠し常駐させる（初回表示の高速化＋edit-start取りこぼし防止）
/// Pre-create the hidden editor at startup (fast first open, no missed edit-start)
pub fn pre_create_editor(app: &AppHandle) {
    if app.get_webview_window("editor").is_none() {
        if let Err(e) = create_editor_window(app) {
            eprintln!("[auracap] failed to pre-create editor window: {e}");
        }
    }
}

fn create_editor_window(app: &AppHandle) -> Result<tauri::WebviewWindow, AnyError> {
    let window = WebviewWindowBuilder::new(app, "editor", WebviewUrl::App("index.html?editor=1".into()))
        .title("AuraCap — 編集")
        .visible(false)
        .resizable(true)
        // 白フラッシュ防止 / Avoid white flash before first paint
        .background_color(tauri::window::Color(24, 24, 27, 255))
        .build()?;
    Ok(window)
}

/// エディタを隠して状態破棄を通知する（ウィンドウは常駐・使い回し）
/// Hide the editor and tell the frontend to reset (the window stays resident)
pub fn hide_editor(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("editor") {
        let _ = window.hide();
    }
    if let Some(state) = app.try_state::<EditorImage>() {
        *state.0.lock().unwrap() = None;
    }
    let _ = app.emit_to(EventTarget::labeled("editor"), "edit-end", ());
}

fn request_png(request: &tauri::ipc::Request<'_>) -> Result<Vec<u8>, String> {
    match request.body() {
        InvokeBody::Raw(bytes) => Ok(bytes.clone()),
        _ => Err("expected raw PNG bytes".into()),
    }
}

// ---- Tauri commands ----

/// 画像の描画準備完了。ここで初めてエディタを表示する（白フラッシュ防止）
/// The image is ready to paint; only now is the editor shown (avoids white flash)
#[tauri::command]
pub fn editor_ready(app: AppHandle) {
    if let Some(window) = app.get_webview_window("editor") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[tauri::command]
pub fn close_editor(app: AppHandle) {
    hide_editor(&app);
}

/// 編集対象画像があるか（フロントのマウント時の取りこぼし対策に使う）
/// Whether an image is pending (frontend uses this as a mount-time race guard)
#[tauri::command]
pub fn editor_has_image(state: tauri::State<'_, EditorImage>) -> bool {
    state.0.lock().unwrap().is_some()
}

/// 編集済みPNGをクリップボードへコピー / Copy the edited PNG to the clipboard
/// デコードが重いので別スレッドで処理する（同期コマンドはメインスレッドで走るため）
/// Decoding is heavy, so it runs on a worker thread (sync commands run on the main thread)
#[tauri::command]
pub fn export_copy(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let png = request_png(&request)?;
    std::thread::spawn(move || {
        let result = (|| -> Result<(), AnyError> {
            let image = xcap::image::load_from_memory(&png)?.to_rgba8();
            let mut clipboard = arboard::Clipboard::new()?;
            clipboard.set_image(arboard::ImageData {
                width: image.width() as usize,
                height: image.height() as usize,
                bytes: std::borrow::Cow::Borrowed(image.as_raw()),
            })?;
            Ok(())
        })();
        if let Err(e) = result {
            eprintln!("[auracap] export copy failed: {e}");
        }
    });
    Ok(())
}

/// 編集済みPNGを名前を付けて保存。ダイアログは非ブロッキング（コールバック）方式：
/// 同期コマンドはメインスレッドで走るため、ブロッキングダイアログはデッドロックする。
/// Save the edited PNG via a save dialog. The dialog is callback-based (non-blocking):
/// sync commands run on the main thread, where a blocking dialog would deadlock.
#[tauri::command]
pub fn export_save(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let png = request_png(&request)?;
    let default_name = format!(
        "auracap_{}.png",
        chrono::Local::now().format("%Y%m%d_%H%M%S")
    );
    let mut dialog = app.dialog().file().add_filter("PNG画像", &["png"]);
    if let Ok(dir) = app.path().picture_dir() {
        dialog = dialog.set_directory(dir);
    }
    let app_for_cb = app.clone();
    dialog.set_file_name(&default_name).save_file(move |path| {
        let Some(path) = path else { return }; // ユーザーがキャンセル / User cancelled
        let result = path
            .into_path()
            .map_err(|e| e.to_string())
            .and_then(|p| std::fs::write(&p, &png).map_err(|e| e.to_string()));
        match result {
            Ok(()) => {
                let _ = app_for_cb.emit_to(EventTarget::labeled("editor"), "export-saved", ());
            }
            Err(e) => eprintln!("[auracap] export save failed: {e}"),
        }
    });
    Ok(())
}
