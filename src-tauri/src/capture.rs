// フリーズフレーム方式のキャプチャセッション管理 / Freeze-frame capture session management
// ADR 0001: ホットキー押下時に先に全モニターを撮影し、その静止画上で領域選択させる
// ADR 0001: Capture all monitors first on hotkey press, then let the user select on the frozen image

use std::collections::HashMap;
use std::io::Cursor;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{
    AppHandle, Emitter, EventTarget, Manager, PhysicalPosition, PhysicalSize, WebviewUrl,
    WebviewWindowBuilder,
};
use xcap::image::imageops;
use xcap::image::{ImageFormat, RgbaImage};
use xcap::Monitor;

use crate::history;

type AnyError = Box<dyn std::error::Error>;

/// キャプチャモード / Capture mode
#[derive(Clone, Copy, PartialEq)]
pub enum CaptureMode {
    Region,
    Window,
}

impl CaptureMode {
    fn as_str(self) -> &'static str {
        match self {
            CaptureMode::Region => "region",
            CaptureMode::Window => "window",
        }
    }
}

/// ウィンドウピッカー用の候補（座標はモニターローカルの物理ピクセル、最前面が先頭）
/// Pickable window candidate (monitor-local physical px, topmost first)
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PickableWindow {
    pub title: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

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
    pub mode: String,
    pub windows: Vec<PickableWindow>,
}

/// 凍結フレーム1枚分。bmpはオーバーレイ表示用（無圧縮・freeze://で配信）
/// One frozen frame. `bmp` is served uncompressed to the overlay via freeze://
pub struct Frame {
    pub info: OverlayInfo,
    pub image: RgbaImage,
    pub bmp: Vec<u8>,
}

/// 1モニター分の撮影結果。並列スレッドから戻る生の組で、この後 Frame へ組み立てる。
/// (モニターID, 物理原点x, 物理原点y, スケール, 撮影画像, 表示用BMP)
/// One monitor's capture result: the raw tuple returned from the parallel threads,
/// assembled into a Frame afterwards.
/// (monitor id, physical origin x, physical origin y, scale, captured image, display BMP)
type CapturedMonitor = (u32, i32, i32, f32, RgbaImage, Vec<u8>);

/// アクティブなキャプチャセッション（空 = セッションなし）
/// Active capture session (empty = no session)
#[derive(Default)]
pub struct SessionState(pub Mutex<HashMap<u32, Frame>>);

/// UIボタン起点のキャプチャか（trueなら完了後にメインウィンドウを再表示する）
/// Whether the capture was started from the UI (if true, re-show the main window when done)
#[derive(Default)]
pub struct UiInitiated(pub AtomicBool);

/// 現在のキャプチャ意図。None=静止画 / Some(delay秒)=動画（選択確定後にdelay秒待って録画）
/// Current capture intent. None = still image, Some(delay) = video (record after `delay`s once the region is chosen)
#[derive(Default)]
pub struct CaptureIntent(pub Mutex<Option<u32>>);

fn set_intent(app: &AppHandle, intent: Option<u32>) {
    if let Some(s) = app.try_state::<CaptureIntent>() {
        *s.0.lock().unwrap() = intent;
    }
}

fn take_intent(app: &AppHandle) -> Option<u32> {
    app.try_state::<CaptureIntent>()
        .and_then(|s| s.0.lock().unwrap().take())
}

fn restore_main_if_needed(app: &AppHandle) {
    if let Some(flag) = app.try_state::<UiInitiated>() {
        if flag.0.swap(false, Ordering::SeqCst) {
            crate::show_main_window(app);
        }
    }
}

/// オーバーレイ式キャプチャ（矩形/ウィンドウ）を開始する
/// Start an overlay-based capture (region / window picking)
pub fn start_overlay_capture(app: &AppHandle, mode: CaptureMode) {
    let app = app.clone();
    // 撮影とBMPエンコードはメインスレッドを塞がないよう別スレッドで行う
    // Capture and BMP encoding run off the main thread to keep the UI responsive
    std::thread::spawn(move || {
        if let Err(e) = begin_session(&app, mode) {
            eprintln!("[auracap] overlay capture failed: {e}");
            end_session(&app);
        }
    });
}

fn begin_session(app: &AppHandle, mode: CaptureMode) -> Result<(), AnyError> {
    let state = app.state::<SessionState>();
    if !state.0.lock().unwrap().is_empty() {
        // セッション中の再発火は無視 / Ignore re-trigger while a session is active
        return Ok(());
    }

    let started = Instant::now();
    // ウィンドウ候補はモニターキャプチャの前に列挙する（Z順を凍結時点に揃える）
    // Enumerate window candidates before capturing (z-order matches the frozen moment)
    let desktop_windows = if mode == CaptureMode::Window {
        list_desktop_windows()
    } else {
        Vec::new()
    };

    // 全モニターを並列に撮影・エンコードする。xcapのMonitorはスレッド間で送れない
    // （Send境界がない）ため、各スレッドがIDで自分のモニターを引き直す。
    // Capture & encode all monitors in parallel. xcap's Monitor is not Send,
    // so each thread re-resolves its own monitor by ID.
    let monitor_ids: Vec<u32> = Monitor::all()?
        .iter()
        .filter_map(|m| m.id().ok())
        .collect();
    let captured: Vec<Result<CapturedMonitor, String>> =
        std::thread::scope(|scope| {
            let handles: Vec<_> = monitor_ids
                .into_iter()
                .map(|id| {
                    scope.spawn(move || -> Result<_, String> {
                        let monitor = Monitor::all()
                            .map_err(|e| e.to_string())?
                            .into_iter()
                            .find(|m| m.id().is_ok_and(|mid| mid == id))
                            .ok_or_else(|| format!("monitor {id} disappeared"))?;
                        let t = Instant::now();
                        let image = monitor.capture_image().map_err(|e| e.to_string())?;
                        let capture_ms = t.elapsed().as_millis();
                        let t = Instant::now();
                        // 表示用は無圧縮BMP：PNG圧縮を避けて高速化 / Uncompressed BMP avoids PNG cost
                        let mut bmp =
                            Vec::with_capacity((image.width() * image.height() * 4 + 64) as usize);
                        image
                            .write_to(&mut Cursor::new(&mut bmp), ImageFormat::Bmp)
                            .map_err(|e| e.to_string())?;
                        eprintln!(
                            "[auracap] monitor {id}: capture {capture_ms}ms, bmp encode {}ms",
                            t.elapsed().as_millis()
                        );
                        let scale = monitor.scale_factor().map_err(|e| e.to_string())?;
                        let (mon_x, mon_y) = to_physical_origin(
                            monitor.x().map_err(|e| e.to_string())?,
                            monitor.y().map_err(|e| e.to_string())?,
                            scale,
                        );
                        Ok((id, mon_x, mon_y, scale, image, bmp))
                    })
                })
                .collect();
            handles.into_iter().map(|h| h.join().unwrap()).collect()
        });

    let mut frames: HashMap<u32, Frame> = HashMap::new();
    for item in captured {
        let (id, mon_x, mon_y, scale, image, bmp) = item?;
        // ウィンドウ候補をモニターローカル座標へ変換 / Convert candidates to monitor-local coords
        let windows: Vec<PickableWindow> = desktop_windows
            .iter()
            .map(|w| PickableWindow {
                title: w.title.clone(),
                x: w.x - mon_x,
                y: w.y - mon_y,
                width: w.width,
                height: w.height,
            })
            .collect();
        let info = OverlayInfo {
            monitor_id: id,
            x: mon_x,
            y: mon_y,
            // 物理ピクセルはキャプチャ画像の実寸から取る / Physical pixels come from the captured image itself
            width: image.width(),
            height: image.height(),
            scale,
            mode: mode.as_str().to_string(),
            windows,
        };
        frames.insert(id, Frame { info, image, bmp });
    }

    let infos: Vec<OverlayInfo> = frames.values().map(|f| f.info.clone()).collect();
    *state.0.lock().unwrap() = frames;

    // 常駐オーバーレイへセッション開始を通知（なければ生成）。
    // WebView2はメッセージポンプを持つスレッドでしか初期化できないため、メインスレッドで行う。
    // Notify resident overlays of the new session (create on demand if missing).
    // WebView2 can only initialize on a thread with a message pump, hence the main thread.
    let app_handle = app.clone();
    app.run_on_main_thread(move || {
        for info in infos {
            let label = format!("overlay-{}", info.monitor_id);
            if app_handle.get_webview_window(&label).is_none() {
                if let Err(e) =
                    create_overlay_window(&app_handle, info.monitor_id, info.x, info.y, info.width, info.height)
                {
                    eprintln!("[auracap] failed to create overlay window: {e}");
                    end_session(&app_handle);
                    return;
                }
            }
            if let Some(window) = app_handle.get_webview_window(&label) {
                // モニター構成変化に備えて位置・サイズを毎回合わせ直す（物理px）
                // Re-sync position/size every session in case the monitor layout changed (physical px)
                let _ = window.set_position(PhysicalPosition::new(info.x, info.y));
                let _ = window.set_size(PhysicalSize::new(info.width, info.height));
                // 影つき枠なしウィンドウは不可視枠のぶんクライアント領域が内側にずれる。
                // 差分だけ外側へ動かし、描画領域をモニターへぴったり一致させる。
                // 影自体は消さない：消すとDWMの高速合成が無効になり描画が極端に遅くなる。
                // The shadow's invisible frame offsets the client area inward; shift the
                // window outward by the measured delta so the client area matches the
                // monitor exactly. The shadow itself stays on: removing it disables DWM's
                // fast composition path and makes rendering extremely slow.
                if let (Ok(outer), Ok(inner)) = (window.outer_position(), window.inner_position()) {
                    let (dx, dy) = (inner.x - outer.x, inner.y - outer.y);
                    if dx != 0 || dy != 0 {
                        let _ = window.set_position(PhysicalPosition::new(info.x - dx, info.y - dy));
                    }
                }
                // 配置結果の診断 / Placement diagnostics
                if let (Ok(pos), Ok(size)) = (window.inner_position(), window.inner_size()) {
                    eprintln!(
                        "[auracap] overlay-{} client ({},{}) {}x{} (monitor ({},{}) {}x{} scale={})",
                        info.monitor_id, pos.x, pos.y, size.width, size.height,
                        info.x, info.y, info.width, info.height, info.scale
                    );
                }
            }
            let _ = app_handle.emit_to(
                EventTarget::labeled(&label),
                "session-start",
                info.monitor_id,
            );
        }
        eprintln!(
            "[auracap] session dispatched in {}ms",
            Instant::now().duration_since(started).as_millis()
        );
    })?;

    // 万一フロントが応答しなくても詰まないよう、2.5秒後に強制表示する保険
    // Safety net: force-show overlays after 2.5s if the frontend never reports ready
    let app_fallback = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(2500));
        let ids: Vec<u32> = app_fallback
            .state::<SessionState>()
            .0
            .lock()
            .unwrap()
            .keys()
            .cloned()
            .collect();
        for id in ids {
            if let Some(w) = app_fallback.get_webview_window(&format!("overlay-{id}")) {
                if !w.is_visible().unwrap_or(true) {
                    eprintln!("[auracap] overlay-{id} not ready after 2.5s, showing anyway");
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
        }
    });
    Ok(())
}

/// 起動時にオーバーレイウィンドウを事前生成して隠し常駐させる（切り替え高速化）
/// Pre-create hidden overlay windows at startup so capture switching is instant
pub fn pre_create_overlays(app: &AppHandle) {
    let monitors = match Monitor::all() {
        Ok(m) => m,
        Err(e) => {
            eprintln!("[auracap] failed to enumerate monitors: {e}");
            return;
        }
    };
    for monitor in monitors {
        let (Ok(id), Ok(x), Ok(y), Ok(w), Ok(h)) = (
            monitor.id(),
            monitor.x(),
            monitor.y(),
            monitor.width(),
            monitor.height(),
        ) else {
            continue;
        };
        if let Err(e) = create_overlay_window(app, id, x, y, w, h) {
            eprintln!("[auracap] failed to pre-create overlay {id}: {e}");
        }
    }
}

fn create_overlay_window(
    app: &AppHandle,
    monitor_id: u32,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<(), AnyError> {
    let label = format!("overlay-{monitor_id}");
    let url = WebviewUrl::App(format!("index.html?overlay={monitor_id}").into());
    let window = WebviewWindowBuilder::new(app, &label, url)
        .decorations(false)
        .resizable(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .visible(false)
        // 透明窓：下の実デスクトップを透過させる（凍結画像を描画せず軽量・高速）
        // Transparent window: let the live desktop show through (no frozen frame painted = light & fast)
        .transparent(true)
        .build()?;
    // 位置・サイズは論理pxではなく物理pxで正確に合わせる（DPI混在対策）
    // Position/size are set in physical px, not logical (mixed-DPI safety)
    window.set_position(PhysicalPosition::new(x, y))?;
    window.set_size(PhysicalSize::new(width, height))?;
    Ok(())
}

/// 凍結画像の描画準備完了。ここで初めてオーバーレイを表示する（白フラッシュ防止）
/// The frozen frame is ready to paint; only now is the overlay shown (avoids white flash)
#[tauri::command]
pub fn overlay_ready(app: AppHandle, monitor_id: u32) {
    if let Some(window) = app.get_webview_window(&format!("overlay-{monitor_id}")) {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// セッションを破棄しオーバーレイを隠す（ウィンドウは常駐させて使い回す）
/// Drop the session and hide overlays (windows stay resident for reuse)
pub fn end_session(app: &AppHandle) {
    if let Some(state) = app.try_state::<SessionState>() {
        state.0.lock().unwrap().clear();
    }
    for (label, window) in app.webview_windows() {
        if label.starts_with("overlay-") {
            let _ = window.hide();
            // フロントの状態と古い凍結画像を破棄させる / Tell the frontend to reset & drop the old frame
            let _ = app.emit_to(EventTarget::labeled(&label), "session-end", ());
        }
    }
    restore_main_if_needed(app);
}

/// 撮影結果を確定する：履歴へ自動保存→クリップボードへコピー→軽量エディタを開く
/// Finalize a capture: auto-save to history, copy to the clipboard, then open the quick editor
pub fn finalize(app: &AppHandle, image: RgbaImage) -> Result<String, AnyError> {
    let path = history::save(app, &image)?;
    copy_to_clipboard(&image)?;
    crate::editor::open_editor(app, &image);
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

/// ルーペ用に凍結画像の一部だけ切り出す（RGBA生バイト列）。範囲外は透明で埋める。
/// カーソル追従で高頻度に呼ばれるため、全体を送らず小さな矩形だけ返す。
/// Crop a small region from the frozen frame for the loupe (raw RGBA bytes); out-of-bounds
/// pixels stay transparent. Called at high frequency while the cursor moves, so keep it tiny.
pub fn crop_loupe_region(image: &RgbaImage, center_x: i32, center_y: i32, size: u32) -> Vec<u8> {
    let (iw, ih) = (image.width() as i32, image.height() as i32);
    let half = (size / 2) as i32;
    let start_x = center_x - half;
    let start_y = center_y - half;
    let raw = image.as_raw();
    let stride = iw as usize * 4;
    let mut buf = vec![0u8; (size * size * 4) as usize];
    for row in 0..size as i32 {
        let sy = start_y + row;
        if sy < 0 || sy >= ih {
            continue;
        }
        let row_base = sy as usize * stride;
        for col in 0..size as i32 {
            let sx = start_x + col;
            if sx < 0 || sx >= iw {
                continue;
            }
            let src = row_base + sx as usize * 4;
            let dst = (row as usize * size as usize + col as usize) * 4;
            buf[dst..dst + 4].copy_from_slice(&raw[src..src + 4]);
        }
    }
    buf
}

// ---- デスクトップウィンドウ列挙（ウィンドウピッカー用） ----
// ---- Desktop window enumeration (for the window picker) ----

struct DesktopWindow {
    title: String,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

/// モニター原点を物理pxへ変換する。macOSのMonitor::x()/y()はポイント単位（DIP）で返るため
/// スケールを掛けて揃える。Windowsは元々物理pxなのでそのまま。
/// Convert a monitor's origin to physical px. macOS's Monitor::x()/y() are in points (DIPs),
/// so scale them; Windows already reports physical px, so pass through unchanged.
#[cfg(target_os = "macos")]
fn to_physical_origin(x: i32, y: i32, scale: f32) -> (i32, i32) {
    ((x as f32 * scale).round() as i32, (y as f32 * scale).round() as i32)
}
#[cfg(not(target_os = "macos"))]
fn to_physical_origin(x: i32, y: i32, _scale: f32) -> (i32, i32) {
    (x, y)
}

/// 実際のアプリウィンドウではなく、システムChrome（メニューバー・Dockの全画面ヒット領域等）
/// を保持しているオーナー名。ウィンドウピッカーの候補から除外する。
/// Owners that hold system chrome (menu bar, Dock's screen-spanning hit area, ...) rather
/// than real app windows. Excluded from the window-picker candidates.
#[cfg(not(windows))]
const SYSTEM_WINDOW_OWNERS: &[&str] = &["Window Server", "Dock"];

/// 可視トップレベルウィンドウをZ順（最前面が先頭）で列挙する
/// List visible top-level windows in z-order (topmost first)
#[cfg(not(windows))]
fn list_desktop_windows() -> Vec<DesktopWindow> {
    // xcapのWindow::allはクロスプラットフォーム（Z順ソート済み）。自プロセスのウィンドウ、
    // システムChrome、最小化・極小サイズのウィンドウは除外する。タイトルが空でも
    // アプリ名があれば候補に残す（表示名はアプリ名にフォールバック）。
    // xcap's Window::all is cross-platform (already z-sorted). Skip our own process's
    // windows, system chrome, minimized windows, and tiny windows. Windows with an empty
    // title still count as candidates (the label falls back to the app name).
    let own_pid = std::process::id();
    xcap::Window::all()
        .unwrap_or_default()
        .into_iter()
        .filter(|w| {
            w.pid().map(|pid| pid != own_pid).unwrap_or(false)
                && !w.is_minimized().unwrap_or(true)
                && w.app_name()
                    .map(|a| !SYSTEM_WINDOW_OWNERS.contains(&a.as_str()))
                    .unwrap_or(false)
        })
        .filter_map(|w| {
            let (width, height) = (w.width().ok()?, w.height().ok()?);
            if width < 8 || height < 8 {
                return None;
            }
            let title = w.title().unwrap_or_default();
            let title = if title.is_empty() { w.app_name().ok()? } else { title };
            // xcapはmacOSでウィンドウ座標をポイント単位（DIP）で返す。物理pxのモニター画像・
            // カーソル座標と揃うよう、所属モニターのスケールを掛けて物理pxへ変換する。
            // xcap reports window coordinates in points (DIPs) on macOS. Scale by the owning
            // monitor's factor to match the physical-px monitor image and cursor coordinates.
            let scale = w
                .current_monitor()
                .and_then(|m| m.scale_factor())
                .unwrap_or(1.0);
            Some(DesktopWindow {
                title,
                x: (w.x().ok()? as f32 * scale).round() as i32,
                y: (w.y().ok()? as f32 * scale).round() as i32,
                width: (width as f32 * scale).round() as u32,
                height: (height as f32 * scale).round() as u32,
            })
        })
        .collect()
}

/// 可視トップレベルウィンドウをZ順（最前面が先頭）で列挙する
/// List visible top-level windows in z-order (topmost first)
#[cfg(windows)]
fn list_desktop_windows() -> Vec<DesktopWindow> {
    use windows::core::BOOL;
    use windows::Win32::Foundation::{HWND, LPARAM, RECT};
    use windows::Win32::Graphics::Dwm::{
        DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS,
    };
    use windows::Win32::System::Threading::GetCurrentProcessId;
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetClassNameW, GetWindowTextLengthW, GetWindowTextW,
        GetWindowThreadProcessId, IsWindowVisible,
    };

    unsafe extern "system" fn enum_cb(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let list = unsafe { &mut *(lparam.0 as *mut Vec<HWND>) };
        list.push(hwnd);
        BOOL::from(true)
    }

    let mut hwnds: Vec<windows::Win32::Foundation::HWND> = Vec::new();
    unsafe {
        // EnumWindowsはZ順（最前面→最背面）で列挙する / EnumWindows yields top-to-bottom z-order
        let _ = EnumWindows(Some(enum_cb), LPARAM(&mut hwnds as *mut _ as isize));
    }

    let own_pid = unsafe { GetCurrentProcessId() };
    let mut result = Vec::new();
    for hwnd in hwnds {
        unsafe {
            if !IsWindowVisible(hwnd).as_bool() {
                continue;
            }
            // UWPのクローク（非表示状態の幽霊）ウィンドウを除外 / Skip cloaked (ghost) UWP windows
            let mut cloaked: u32 = 0;
            let _ = DwmGetWindowAttribute(
                hwnd,
                DWMWA_CLOAKED,
                &mut cloaked as *mut _ as *mut core::ffi::c_void,
                std::mem::size_of::<u32>() as u32,
            );
            if cloaked != 0 {
                continue;
            }
            if GetWindowTextLengthW(hwnd) == 0 {
                continue;
            }
            // 自プロセス（オーバーレイ・メイン）を除外 / Skip our own windows
            let mut pid: u32 = 0;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            if pid == own_pid {
                continue;
            }
            // デスクトップシェルの背景ウィンドウを除外 / Skip desktop shell background windows
            let mut class_buf = [0u16; 64];
            let class_len = GetClassNameW(hwnd, &mut class_buf);
            let class_name = String::from_utf16_lossy(&class_buf[..class_len.max(0) as usize]);
            if class_name == "Progman" || class_name == "WorkerW" {
                continue;
            }
            // 影を除いた見た目通りの境界 / Visible bounds excluding the drop shadow
            let mut rect = RECT::default();
            if DwmGetWindowAttribute(
                hwnd,
                DWMWA_EXTENDED_FRAME_BOUNDS,
                &mut rect as *mut _ as *mut core::ffi::c_void,
                std::mem::size_of::<RECT>() as u32,
            )
            .is_err()
            {
                continue;
            }
            let width = (rect.right - rect.left).max(0) as u32;
            let height = (rect.bottom - rect.top).max(0) as u32;
            if width < 8 || height < 8 {
                continue;
            }
            let mut title_buf = vec![0u16; 256];
            let title_len = GetWindowTextW(hwnd, &mut title_buf);
            let title = String::from_utf16_lossy(&title_buf[..title_len.max(0) as usize]);
            result.push(DesktopWindow {
                title,
                x: rect.left,
                y: rect.top,
                width,
                height,
            });
        }
    }
    result
}

#[cfg(windows)]
fn cursor_pos() -> Result<(i32, i32), AnyError> {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
    let mut point = POINT::default();
    unsafe { GetCursorPos(&mut point)? };
    Ok((point.x, point.y))
}

#[cfg(target_os = "macos")]
fn cursor_pos() -> Result<(i32, i32), AnyError> {
    use core_graphics::event::CGEvent;
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
    let source = CGEventSource::new(CGEventSourceStateID::HIDSystemState)
        .map_err(|_| "CGEventSourceの初期化に失敗 / failed to init CGEventSource")?;
    let event =
        CGEvent::new(source).map_err(|_| "CGEventの取得に失敗 / failed to create CGEvent")?;
    let point = event.location();
    Ok((point.x as i32, point.y as i32))
}

// ---- Tauri commands (フロントエンドから呼ばれる / invoked from the frontend) ----

/// UI（ボタン・トレイメニュー）からのキャプチャ起動。
/// 自分自身の写り込みを防ぐため、メインウィンドウを隠してから撮影する。
/// Capture initiated from the UI (buttons / tray menu).
/// The main window is hidden first so it does not appear in the capture.
#[tauri::command]
pub fn start_capture(app: AppHandle, mode: String, delay: Option<u32>) {
    // 静止画キャプチャ / Still-image capture
    set_intent(&app, None);
    trigger_capture(app, mode, delay.unwrap_or(0));
}

/// 動画キャプチャ。領域/ウィンドウは静止画と同じ選択オーバーレイを流用し、選択確定後に
/// delay秒（カウントダウン表示なし）待って録画を開始する。全画面は選択不要で即遅延録画。
/// Video capture. Region/window reuse the same selection overlay as still capture; after the
/// region is chosen, recording starts after `delay`s (no countdown UI). Fullscreen records directly.
#[tauri::command]
pub fn start_video(app: AppHandle, mode: String, delay: Option<u32>) {
    let delay = delay.unwrap_or(3);
    eprintln!("[auracap] start_video mode={mode} delay={delay}");
    set_intent(&app, Some(delay));
    match mode.as_str() {
        // 選択中は遅延を入れない（選んだ後にdelay秒待つ）/ No pre-delay during selection
        "region" => trigger_capture(app, "region".into(), 0),
        "window" => trigger_capture(app, "window".into(), 0),
        "fullscreen" => crate::recorder::start_fullscreen_recording(&app, delay),
        other => eprintln!("[auracap] unknown video mode: {other}"),
    }
}

/// キャプチャ起動の共通処理：メイン窓を隠し、遅延後にモードに応じたキャプチャを行う。
/// Shared capture trigger: hide the main window, then run the capture for the mode after a delay.
fn trigger_capture(app: AppHandle, mode: String, delay: u32) {
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
        if was_visible {
            // ウィンドウが画面合成から消えるのを待つ / Wait for the window to leave composition
            std::thread::sleep(Duration::from_millis(250));
        }
        if delay > 0 {
            std::thread::sleep(Duration::from_secs(delay as u64));
        }
        match mode.as_str() {
            "region" => start_overlay_capture(&app, CaptureMode::Region),
            "window" => start_overlay_capture(&app, CaptureMode::Window),
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

// 注意: このコマンドは必ずasyncにすること。同期コマンドはメインスレッドで実行され、
// finalize内のエディタウィンドウ生成がイベントループと相互待ちしてデッドロックする。
// NOTE: this command MUST stay async. Sync commands run on the main thread, and the
// editor window creation inside finalize() deadlocks against the event loop there.
#[tauri::command]
pub async fn finish_region_capture(
    app: AppHandle,
    monitor_id: u32,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
) -> Result<String, String> {
    // 動画意図なら、選択矩形をそのまま録画する（画像化はしない）。矩形はモニター基準の物理px。
    // If the intent is video, record the selected rectangle directly (no still image). Rect is monitor-relative physical px.
    if let Some(delay) = take_intent(&app) {
        // 選択モニターの絶対原点を取得し、その上の点で録画対象モニターを特定する
        // Get the selected monitor's absolute origin to resolve which monitor to record
        let origin = {
            let state = app.state::<SessionState>();
            let guard = state.0.lock().unwrap();
            guard.get(&monitor_id).map(|f| (f.info.x, f.info.y))
        };
        end_session(&app);
        let (ox, oy) = origin.unwrap_or((0, 0));
        // 矩形の絶対座標（黄色枠とモニター特定に使う）/ Rect's absolute origin (for the frame and monitor resolution)
        let abs = (ox + x as i32, oy + y as i32);
        eprintln!(
            "[auracap] start region video: monitor={monitor_id} origin=({ox},{oy}) rect=({x},{y},{width},{height}) delay={delay}"
        );
        crate::recorder::start_region_recording(&app, abs, x, y, width, height, delay);
        return Ok(String::new());
    }
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
    // 動画選択をキャンセルした場合は意図フラグも消す / Clear the video intent if the selection was canceled
    take_intent(&app);
    end_session(&app);
}
