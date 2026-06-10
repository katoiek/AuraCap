// フリーズフレーム方式のキャプチャセッション管理 / Freeze-frame capture session management
// ADR 0001: ホットキー押下時に先に全モニターを撮影し、その静止画上で領域選択させる
// ADR 0001: Capture all monitors first on hotkey press, then let the user select on the frozen image

use std::collections::HashMap;
use std::fs;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};
use xcap::image::imageops;
use xcap::image::RgbaImage;
use xcap::Monitor;

use crate::history;

type AnyError = Box<dyn std::error::Error>;

/// オーバーレイ表示に必要なモニター情報（座標・サイズは物理ピクセル）
/// Monitor info for the overlay (coordinates/sizes in physical pixels)
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OverlayInfo {
    pub monitor_id: u32,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale: f32,
    pub image_path: String,
}

/// 凍結フレーム1枚分 / One frozen frame
pub struct Frame {
    pub info: OverlayInfo,
    pub image: RgbaImage,
}

/// アクティブなキャプチャセッション（空 = セッションなし）
/// Active capture session (empty = no session)
#[derive(Default)]
pub struct SessionState(pub Mutex<HashMap<u32, Frame>>);

/// UIボタン起点のキャプチャか（trueなら完了後にメインウィンドウを再表示する）
/// Whether the capture was started from the UI (if true, re-show the main window when done)
#[derive(Default)]
pub struct UiInitiated(pub AtomicBool);

fn restore_main_if_needed(app: &AppHandle) {
    if let Some(flag) = app.try_state::<UiInitiated>() {
        if flag.0.swap(false, Ordering::SeqCst) {
            crate::show_main_window(app);
        }
    }
}

/// 領域選択キャプチャを開始する / Start a region-selection capture
pub fn start_region_capture(app: &AppHandle) {
    let app = app.clone();
    // 撮影とPNG書き出しはメインスレッドを塞がないよう別スレッドで行う
    // Capture and PNG encoding run off the main thread to keep the UI responsive
    std::thread::spawn(move || {
        if let Err(e) = begin_session(&app) {
            eprintln!("[auracap] region capture failed: {e}");
            end_session(&app);
        }
    });
}

fn begin_session(app: &AppHandle) -> Result<(), AnyError> {
    let state = app.state::<SessionState>();
    if !state.0.lock().unwrap().is_empty() {
        // セッション中の再発火は無視 / Ignore re-trigger while a session is active
        return Ok(());
    }

    let freeze_dir = app.path().app_data_dir()?.join("freeze");
    fs::create_dir_all(&freeze_dir)?;

    let mut frames: HashMap<u32, Frame> = HashMap::new();
    for monitor in Monitor::all()? {
        let id = monitor.id()?;
        let image = monitor.capture_image()?;
        let path = freeze_dir.join(format!("{id}.png"));
        image.save(&path)?;
        let info = OverlayInfo {
            monitor_id: id,
            x: monitor.x()?,
            y: monitor.y()?,
            // 物理ピクセルはキャプチャ画像の実寸から取る / Physical pixels come from the captured image itself
            width: image.width(),
            height: image.height(),
            scale: monitor.scale_factor()?,
            image_path: path.to_string_lossy().into_owned(),
        };
        frames.insert(id, Frame { info, image });
    }

    let infos: Vec<OverlayInfo> = frames.values().map(|f| f.info.clone()).collect();
    *state.0.lock().unwrap() = frames;

    // WebView2はメッセージポンプを持つスレッドでしか初期化できないため、
    // ウィンドウ生成は必ずメインスレッドへディスパッチする
    // WebView2 can only initialize on a thread with a message pump,
    // so window creation must be dispatched to the main thread
    let app_handle = app.clone();
    app.run_on_main_thread(move || {
        for info in infos {
            if let Err(e) = create_overlay_window(&app_handle, &info) {
                eprintln!("[auracap] failed to create overlay window: {e}");
                end_session(&app_handle);
                return;
            }
        }
    })?;
    Ok(())
}

fn create_overlay_window(app: &AppHandle, info: &OverlayInfo) -> Result<(), AnyError> {
    let label = format!("overlay-{}", info.monitor_id);
    let url = WebviewUrl::App(format!("index.html?overlay={}", info.monitor_id).into());
    let window = WebviewWindowBuilder::new(app, &label, url)
        .decorations(false)
        .resizable(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .visible(false)
        .build()?;
    // 位置・サイズは論理pxではなく物理pxで正確に合わせる（DPI混在対策）
    // Position/size are set in physical px, not logical (mixed-DPI safety)
    window.set_position(PhysicalPosition::new(info.x, info.y))?;
    window.set_size(PhysicalSize::new(info.width, info.height))?;
    window.show()?;
    window.set_focus()?;
    Ok(())
}

/// セッションを破棄しオーバーレイを全て閉じる / Drop the session and close all overlays
pub fn end_session(app: &AppHandle) {
    if let Some(state) = app.try_state::<SessionState>() {
        state.0.lock().unwrap().clear();
    }
    for (label, window) in app.webview_windows() {
        if label.starts_with("overlay-") {
            let _ = window.destroy();
        }
    }
    restore_main_if_needed(app);
}

/// 撮影結果を確定する：履歴へ自動保存し、クリップボードへコピー
/// Finalize a capture: auto-save to history and copy to the clipboard
pub fn finalize(app: &AppHandle, image: RgbaImage) -> Result<String, AnyError> {
    let path = history::save(app, &image)?;
    copy_to_clipboard(&image)?;
    Ok(path.to_string_lossy().into_owned())
}

fn copy_to_clipboard(image: &RgbaImage) -> Result<(), AnyError> {
    let mut clipboard = arboard::Clipboard::new()?;
    clipboard.set_image(arboard::ImageData {
        width: image.width() as usize,
        height: image.height() as usize,
        bytes: std::borrow::Cow::Borrowed(image.as_raw()),
    })?;
    Ok(())
}

/// カーソルのあるモニターを全画面キャプチャ / Capture the full monitor under the cursor
pub fn capture_fullscreen(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let result = (|| -> Result<(), AnyError> {
            let (cx, cy) = cursor_pos()?;
            let monitor = Monitor::from_point(cx, cy)?;
            let image = monitor.capture_image()?;
            finalize(&app, image)?;
            Ok(())
        })();
        if let Err(e) = result {
            eprintln!("[auracap] fullscreen capture failed: {e}");
        }
        restore_main_if_needed(&app);
    });
}

/// 前面ウィンドウをキャプチャ / Capture the foreground window
pub fn capture_window(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let result = (|| -> Result<(), AnyError> {
            let rect = foreground_window_rect()?;
            // ウィンドウ中心が属するモニターを撮影し、ウィンドウ矩形との交差部分を切り出す
            // Capture the monitor containing the window center and crop the intersection
            let center_x = (rect.left + rect.right) / 2;
            let center_y = (rect.top + rect.bottom) / 2;
            let monitor = Monitor::from_point(center_x, center_y)?;
            let image = monitor.capture_image()?;
            let (mon_x, mon_y) = (monitor.x()?, monitor.y()?);

            let left = (rect.left - mon_x).max(0) as u32;
            let top = (rect.top - mon_y).max(0) as u32;
            let right = ((rect.right - mon_x).max(0) as u32).min(image.width());
            let bottom = ((rect.bottom - mon_y).max(0) as u32).min(image.height());
            if right <= left || bottom <= top {
                return Err("window rect is outside the captured monitor".into());
            }
            let cropped =
                imageops::crop_imm(&image, left, top, right - left, bottom - top).to_image();
            finalize(&app, cropped)?;
            Ok(())
        })();
        if let Err(e) = result {
            eprintln!("[auracap] window capture failed: {e}");
        }
        restore_main_if_needed(&app);
    });
}

struct WinRect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

fn cursor_pos() -> Result<(i32, i32), AnyError> {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
    let mut point = POINT::default();
    unsafe { GetCursorPos(&mut point)? };
    Ok((point.x, point.y))
}

fn foreground_window_rect() -> Result<WinRect, AnyError> {
    use windows::Win32::Foundation::RECT;
    use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS};
    use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;

    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.is_invalid() {
        return Err("no foreground window".into());
    }
    // 影を除いた見た目通りの境界を取得 / Visible bounds excluding the drop shadow
    let mut rect = RECT::default();
    unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut rect as *mut _ as *mut core::ffi::c_void,
            std::mem::size_of::<RECT>() as u32,
        )?;
    }
    Ok(WinRect {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
    })
}

// ---- Tauri commands (フロントエンドから呼ばれる / invoked from the frontend) ----

/// UI（ボタン・トレイメニュー）からのキャプチャ起動。
/// 自分自身の写り込みを防ぐため、メインウィンドウを隠してから撮影する。
/// Capture initiated from the UI (buttons / tray menu).
/// The main window is hidden first so it does not appear in the capture.
#[tauri::command]
pub fn start_capture(app: AppHandle, mode: String) {
    let was_visible = app
        .get_webview_window("main")
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false);
    if was_visible {
        if let Some(main) = app.get_webview_window("main") {
            let _ = main.hide();
        }
        if let Some(flag) = app.try_state::<UiInitiated>() {
            flag.0.store(true, Ordering::SeqCst);
        }
    }
    std::thread::spawn(move || {
        // ウィンドウが画面合成から消えるのを待つ / Wait for the window to leave composition
        std::thread::sleep(Duration::from_millis(250));
        match mode.as_str() {
            "region" => start_region_capture(&app),
            "window" => capture_window(&app),
            "fullscreen" => capture_fullscreen(&app),
            other => eprintln!("[auracap] unknown capture mode: {other}"),
        }
    });
}

#[tauri::command]
pub fn get_overlay_info(
    state: tauri::State<'_, SessionState>,
    monitor_id: u32,
) -> Option<OverlayInfo> {
    state.0.lock().unwrap().get(&monitor_id).map(|f| f.info.clone())
}

#[tauri::command]
pub fn finish_region_capture(
    app: AppHandle,
    monitor_id: u32,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
) -> Result<String, String> {
    let cropped = {
        let state = app.state::<SessionState>();
        let guard = state.0.lock().unwrap();
        let frame = guard
            .get(&monitor_id)
            .ok_or("no active capture session")?;
        let image = &frame.image;
        // 矩形を画像内にクランプ / Clamp the rectangle inside the image
        let x = x.min(image.width().saturating_sub(1));
        let y = y.min(image.height().saturating_sub(1));
        let w = width.clamp(1, image.width() - x);
        let h = height.clamp(1, image.height() - y);
        imageops::crop_imm(image, x, y, w, h).to_image()
    };
    end_session(&app);
    finalize(&app, cropped).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn cancel_capture(app: AppHandle) {
    end_session(&app);
}
