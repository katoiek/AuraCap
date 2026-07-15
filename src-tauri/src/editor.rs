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

/// 編集対象の画像（edit://で配信する表示用エンコード画像）
/// The image being edited (display-encoded image served via edit://)
#[derive(Default)]
pub struct EditorImage(pub Mutex<Option<Vec<u8>>>);

/// 表示用エンコード形式。WindowsのWebView2(Chromium)は無圧縮BMPが高速だが、
/// macOSのWKWebView(WebKit)は`<img>`でのBMPデコードに対応していないためPNGを使う。
/// Display encoding format. WebView2 (Chromium) on Windows handles uncompressed BMP
/// fast, but WKWebView (WebKit) on macOS can't decode BMP in `<img>`, so use PNG there.
#[cfg(target_os = "macos")]
pub(crate) const EDITOR_IMAGE_FORMAT: ImageFormat = ImageFormat::Png;
#[cfg(not(target_os = "macos"))]
pub(crate) const EDITOR_IMAGE_FORMAT: ImageFormat = ImageFormat::Bmp;

/// 撮影結果をエディタで開く / Open a capture result in the editor
pub fn open_editor(app: &AppHandle, image: &RgbaImage) {
    let mut encoded = Vec::with_capacity((image.width() * image.height() * 4 + 64) as usize);
    if let Err(e) = image.write_to(&mut Cursor::new(&mut encoded), EDITOR_IMAGE_FORMAT) {
        eprintln!("[auracap] editor image encode failed: {e}");
        return;
    }
    if let Some(state) = app.try_state::<EditorImage>() {
        *state.0.lock().unwrap() = Some(encoded);
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

/// テンプレートからファイル名を生成する。{date}{time}{YYYY}{MM}{DD}{HH}{mm}{ss} を展開し、
/// パスに使えない文字は "_" に置換、指定拡張子を付与する。
/// Build a file name from the template: expand date/time tokens, sanitize invalid path
/// characters to "_", and append the given extension.
pub(crate) fn build_file_name(template: &str, ext: &str) -> String {
    let now = chrono::Local::now();
    let tmpl = template.trim();
    let tmpl = if tmpl.is_empty() {
        "auracap_{date}_{time}"
    } else {
        tmpl
    };
    let replaced = tmpl
        .replace("{date}", &now.format("%Y%m%d").to_string())
        .replace("{time}", &now.format("%H%M%S").to_string())
        .replace("{YYYY}", &now.format("%Y").to_string())
        .replace("{MM}", &now.format("%m").to_string())
        .replace("{DD}", &now.format("%d").to_string())
        .replace("{HH}", &now.format("%H").to_string())
        .replace("{mm}", &now.format("%M").to_string())
        .replace("{ss}", &now.format("%S").to_string());
    // 不正文字を "_" に / Replace path-invalid characters with "_"
    let sanitized: String = replaced
        .chars()
        .map(|c| match c {
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ => c,
        })
        .collect();
    let base = sanitized.trim();
    let base = if base.is_empty() { "auracap" } else { base };
    format!("{base}.{ext}")
}

/// 保存形式を拡張子に正規化する（フロントの toBlob と一致させる） / Normalize the save format to an extension
fn format_ext(format: &str) -> &'static str {
    match format.to_lowercase().as_str() {
        "jpg" | "jpeg" => "jpg",
        "webp" => "webp",
        _ => "png",
    }
}

/// 保存先フォルダを解決する。空文字や存在しないパスはピクチャにフォールバック
/// Resolve the save folder; fall back to Pictures when empty or missing
pub(crate) fn resolve_save_dir(app: &AppHandle, configured: &str) -> std::path::PathBuf {
    if !configured.is_empty() {
        let p = std::path::PathBuf::from(configured);
        if p.is_dir() {
            return p;
        }
    }
    app.path()
        .picture_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."))
}

/// 同名ファイルがあれば連番を付けて衝突回避 / Append a counter when the name already exists
pub(crate) fn unique_path(dir: &std::path::Path, name: &str) -> std::path::PathBuf {
    let candidate = dir.join(name);
    if !candidate.exists() {
        return candidate;
    }
    let (stem, ext) = name.rsplit_once('.').unwrap_or((name, ""));
    for i in 1.. {
        let alt = if ext.is_empty() {
            format!("{stem}_{i}")
        } else {
            format!("{stem}_{i}.{ext}")
        };
        let p = dir.join(alt);
        if !p.exists() {
            return p;
        }
    }
    candidate
}

/// 保存したフォルダを設定に記憶する（"last"モードと初期表示用・自動更新）
/// Remember the folder we saved into (auto-updates "last" mode and the dialog's initial location)
pub(crate) fn remember_save_dir(app: &AppHandle, dir: &std::path::Path) {
    if let Some(state) = app.try_state::<crate::settings::SettingsState>() {
        let snapshot = {
            let mut s = state.0.lock().unwrap();
            s.last_save_dir = dir.to_string_lossy().to_string();
            s.clone()
        };
        let _ = crate::settings::save(app, &snapshot);
    }
}

/// 編集済みPNGを保存。保存モードに応じて、即保存／ダイアログを切り替える。
/// ダイアログは非ブロッキング（コールバック）方式：同期コマンドはメインスレッドで走るため、
/// ブロッキングダイアログはデッドロックする。
/// Save the edited PNG. Depending on save_mode it writes straight to the fixed folder or shows a
/// dialog. The dialog is callback-based (non-blocking): a blocking dialog on the main thread would deadlock.
#[tauri::command]
pub fn export_save(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let png = request_png(&request)?;
    let s = crate::settings::load(&app);
    let ext = format_ext(&s.save_format);
    let default_name = build_file_name(&s.file_name_template, ext);

    // 指定フォルダに即保存（ダイアログ無し）/ Save straight to the fixed folder, no dialog
    if s.save_mode == "fixed" {
        let dir = resolve_save_dir(&app, &s.save_dir);
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("保存先を作成できません / cannot create folder: {e}"))?;
        let path = unique_path(&dir, &default_name);
        std::fs::write(&path, &png).map_err(|e| e.to_string())?;
        remember_save_dir(&app, &dir);
        // フォルダ名をペイロードに載せて保存先を知らせる / Pass the folder so the toast can show where it went
        let _ = app.emit_to(
            EventTarget::labeled("editor"),
            "export-saved",
            dir.to_string_lossy().to_string(),
        );
        return Ok(());
    }

    // ダイアログの初期フォルダ："last"は前回保存先、それ以外は既定 / Initial folder: last for "last" mode, else default
    let initial = if s.save_mode == "last" && !s.last_save_dir.is_empty() {
        resolve_save_dir(&app, &s.last_save_dir)
    } else {
        resolve_save_dir(&app, &s.save_dir)
    };
    let app_for_cb = app.clone();
    app.dialog()
        .file()
        .add_filter("画像", &[ext])
        .set_directory(initial)
        .set_file_name(&default_name)
        .save_file(move |path| {
            let Some(path) = path else { return }; // ユーザーがキャンセル / User cancelled
            let pathbuf = match path.into_path() {
                Ok(p) => p,
                Err(e) => {
                    eprintln!("[auracap] export save path error: {e}");
                    return;
                }
            };
            match std::fs::write(&pathbuf, &png) {
                Ok(()) => {
                    if let Some(parent) = pathbuf.parent() {
                        remember_save_dir(&app_for_cb, parent);
                    }
                    let _ = app_for_cb.emit_to(EventTarget::labeled("editor"), "export-saved", ());
                }
                Err(e) => eprintln!("[auracap] export save failed: {e}"),
            }
        });
    Ok(())
}

/// フォルダ選択ダイアログを開き、選ばれたパスを返す（設定画面の「保存先」変更用）。
/// asyncコマンドはメインスレッド外で動くため、ブロッキング版を安全に使える。
/// Open a folder picker and return the chosen path (for changing the "save folder" in settings).
/// Async commands run off the main thread, so the blocking picker is safe here.
#[tauri::command]
pub async fn pick_save_dir(app: AppHandle) -> Option<String> {
    app.dialog()
        .file()
        .blocking_pick_folder()
        .and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().to_string())
}
