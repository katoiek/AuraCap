// 画面録画：Windows Graphics Capture (WGC) でモニターを取得し H.264/MP4 にエンコードする。
// 全画面はフレームをそのまま、領域録画はモニターを取得して各フレームを矩形にクロップする。
// Screen recording via WGC → H.264/MP4. Fullscreen sends frames as-is; region recording
// captures the monitor and crops each frame to the selected rectangle.

use std::ffi::c_void;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder,
};
use windows::Win32::Foundation::POINT;
use windows::Win32::Graphics::Gdi::{MonitorFromPoint, MONITOR_DEFAULTTONEAREST};
use windows_capture::capture::{CaptureControl, Context, GraphicsCaptureApiHandler};
use windows_capture::encoder::{
    AudioSettingsBuilder, ContainerSettingsBuilder, VideoEncoder, VideoSettingsBuilder,
};
use windows_capture::frame::Frame;
use windows_capture::graphics_capture_api::InternalCaptureControl;
use windows_capture::monitor::Monitor;
use windows_capture::settings::{
    ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
    MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
};

type RecError = Box<dyn std::error::Error + Send + Sync>;

/// クロップ矩形（モニター左上基準・物理px・偶数整列済み）/ Crop rect (monitor-relative, physical px, even-aligned)
#[derive(Clone, Copy)]
pub struct CropRect {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

/// 録画開始時にハンドラへ渡す情報 / Passed to the handler on start
#[derive(Clone)]
pub struct RecordFlags {
    path: String,
    out_w: u32,
    out_h: u32,
    crop: Option<CropRect>,
}

/// WGCのフレームを受け取りエンコーダへ流すハンドラ / Receives WGC frames and feeds the encoder
pub struct Recorder {
    // 外部停止（on_closed）でも確実に finish できるよう Option で保持
    // Hold as Option so we can finish() even on external stop (on_closed)
    encoder: Option<VideoEncoder>,
    crop: Option<CropRect>,
    out_w: u32,
    out_h: u32,
    start: Instant,
    // クロップ済みフレームの出力先を使い回す（毎フレームの確保を避ける）
    // Reusable output buffer for cropped frames (avoids per-frame allocation)
    out_buf: Vec<u8>,
}

impl GraphicsCaptureApiHandler for Recorder {
    type Flags = RecordFlags;
    type Error = RecError;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        let f = ctx.flags;
        let encoder = VideoEncoder::new(
            VideoSettingsBuilder::new(f.out_w, f.out_h),
            AudioSettingsBuilder::default().disabled(true),
            ContainerSettingsBuilder::default(),
            &f.path,
        )?;
        Ok(Self {
            encoder: Some(encoder),
            crop: f.crop,
            out_w: f.out_w,
            out_h: f.out_h,
            start: Instant::now(),
            out_buf: Vec::new(),
        })
    }

    fn on_frame_arrived(
        &mut self,
        frame: &mut Frame<'_>,
        _capture_control: InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        // フィールドを分解して借用衝突を避ける（encoder と out_buf を同時に可変借用）
        // Destructure to borrow encoder and out_buf mutably at the same time
        let Recorder {
            encoder,
            crop,
            out_w,
            out_h,
            start,
            out_buf,
        } = self;
        let Some(enc) = encoder.as_mut() else {
            return Ok(());
        };
        match *crop {
            // 全画面：フレームをそのままエンコード / Fullscreen: encode the frame as-is
            None => {
                enc.send_frame(frame)?;
            }
            // 領域：生バッファ（パディング込み）から矩形を直接切り出し、上下反転して送る。
            // 全画面コピーを避けるため as_raw_buffer + row_pitch を使う。
            // Region: crop directly from the raw (padded) buffer and flip vertically.
            // Use as_raw_buffer + row_pitch to avoid copying the whole monitor each frame.
            Some(c) => {
                let mut fb = frame.buffer()?;
                let pitch = fb.row_pitch() as usize; // 1行のバイト数（パディング込み）/ bytes per row incl. padding
                let src = fb.as_raw_buffer();
                let ow = *out_w as usize;
                let oh = *out_h as usize;
                let cx = c.x as usize;
                let cy = c.y as usize;
                let row_bytes = ow * 4;
                let needed = row_bytes * oh;
                if out_buf.len() != needed {
                    out_buf.resize(needed, 0);
                }
                for row in 0..oh {
                    let src_off = (cy + row) * pitch + cx * 4;
                    let dst_off = (oh - 1 - row) * row_bytes; // 下から上へ / bottom-to-top
                    if src_off + row_bytes <= src.len() {
                        out_buf[dst_off..dst_off + row_bytes]
                            .copy_from_slice(&src[src_off..src_off + row_bytes]);
                    }
                }
                let ts = (start.elapsed().as_nanos() / 100) as i64; // 100ns単位 / 100ns units
                enc.send_frame_buffer(out_buf, ts)?;
            }
        }
        Ok(())
    }

    fn on_closed(&mut self) -> Result<(), Self::Error> {
        // 外部から停止された場合はここで MP4 を確定させる / Finalize the MP4 when stopped externally
        if let Some(enc) = self.encoder.take() {
            enc.finish()?;
        }
        Ok(())
    }
}

type RecControl = CaptureControl<Recorder, RecError>;

/// 録画中の状態（停止用のCaptureControlと出力先を保持） / Active recording state
pub struct Active {
    control: RecControl,
    path: PathBuf,
    has_frame: bool,
}

#[derive(Default)]
pub struct RecorderState(pub Mutex<Option<Active>>);

/// 録画の保存先フォルダ。スクショ（export_save）と同じ解決規則に揃える。
/// Recording output folder, matching the screenshot (export_save) rule.
fn recordings_dir(app: &AppHandle) -> PathBuf {
    let s = crate::settings::load(app);
    let configured = if s.save_mode == "last" && !s.last_save_dir.is_empty() {
        s.last_save_dir
    } else {
        s.save_dir
    };
    if !configured.is_empty() {
        let p = PathBuf::from(&configured);
        if p.is_dir() {
            return p;
        }
    }
    app.path()
        .picture_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
}

/// 録画対象 / What to record
pub enum RecordTarget {
    /// 全画面（プライマリモニター）/ Fullscreen (primary monitor)
    Fullscreen,
    /// 矩形録画。abs は矩形の絶対座標（物理px・モニター特定と黄色枠に使用）、crop はモニター基準
    /// Rectangle recording. `abs` is the rect's absolute origin (used to resolve the monitor and draw the frame); `crop` is monitor-relative
    Region { abs: (i32, i32), crop: CropRect },
}

/// 黄色枠バー（4本）のウィンドウラベル / Window labels for the yellow frame bars
const FRAME_LABELS: [&str; 4] = ["recframe-0", "recframe-1", "recframe-2", "recframe-3"];

/// 選択矩形の外側に黄色い枠バーを表示する（録画範囲には映り込まない・クリック素通し）
/// Show yellow frame bars just outside the rect (never captured; click-through)
fn show_rec_frame(app: &AppHandle, abs_x: i32, abs_y: i32, w: u32, h: u32) {
    let t: i32 = 3; // 枠の太さ（物理px・静止画の選択枠と統一）/ border thickness (physical px; matches the still selection)
    let (w, h) = (w as i32, h as i32);
    let rects: [(i32, i32, u32, u32); 4] = [
        (abs_x - t, abs_y - t, (w + 2 * t) as u32, t as u32), // 上 / top
        (abs_x - t, abs_y + h, (w + 2 * t) as u32, t as u32), // 下 / bottom
        (abs_x - t, abs_y, t as u32, h as u32),               // 左 / left
        (abs_x + w, abs_y, t as u32, h as u32),               // 右 / right
    ];
    let app = app.clone();
    let _ = app.clone().run_on_main_thread(move || {
        for (i, (rx, ry, rw, rh)) in rects.iter().enumerate() {
            let label = FRAME_LABELS[i];
            if app.get_webview_window(label).is_some() {
                continue;
            }
            match WebviewWindowBuilder::new(
                &app,
                label,
                WebviewUrl::App("index.html?recframe=1".into()),
            )
            .title("AuraCap")
            .decorations(false)
            .resizable(false)
            .skip_taskbar(true)
            .always_on_top(true)
            .focused(false)
            .shadow(false)
            // 既定サイズで一瞬表示されるのを防ぐため隠して作り、位置確定後に表示する
            // Build hidden to avoid a flash at the default size; show after positioning
            .visible(false)
            .background_color(tauri::window::Color(250, 204, 21, 255)) // amber-400
            .build()
            {
                Ok(win) => {
                    let _ = win.set_position(PhysicalPosition::new(*rx, *ry));
                    let _ = win.set_size(PhysicalSize::new(*rw, *rh));
                    let _ = win.set_ignore_cursor_events(true);
                    let _ = win.show();
                }
                Err(e) => eprintln!("[auracap] rec frame {label} failed: {e}"),
            }
        }
    });
}

/// 黄色枠バーを閉じる / Close the yellow frame bars
fn hide_rec_frame(app: &AppHandle) {
    let app = app.clone();
    let _ = app.clone().run_on_main_thread(move || {
        for label in FRAME_LABELS {
            if let Some(w) = app.get_webview_window(label) {
                let _ = w.close();
            }
        }
    });
}

/// 絶対座標の点が乗っているモニターを取得 / Resolve the monitor that contains an absolute point
fn monitor_at(point: (i32, i32)) -> Result<Monitor, String> {
    let hmon = unsafe {
        MonitorFromPoint(
            POINT {
                x: point.0,
                y: point.1,
            },
            MONITOR_DEFAULTTONEAREST,
        )
    };
    if hmon.0.is_null() {
        return Err("モニターの特定に失敗 / could not resolve monitor".into());
    }
    Ok(Monitor::from_raw_hmonitor(hmon.0 as *mut c_void))
}

/// 録画を開始する。Fullscreen で全画面、Region でそのモニターの矩形のみ。保存先パスを返す。
/// Begin recording. Fullscreen records the primary monitor; Region records only that rectangle.
fn begin_recording(app: &AppHandle, target: RecordTarget) -> Result<String, String> {
    let state = app.state::<RecorderState>();
    if state.0.lock().unwrap().is_some() {
        return Err("既に録画中です / already recording".into());
    }

    // 録画対象のモニターと、矩形の絶対座標（黄色枠用）/ Target monitor and the rect's absolute origin (for the frame)
    let (monitor, crop, abs) = match target {
        RecordTarget::Fullscreen => (
            Monitor::primary().map_err(|e| format!("モニター取得に失敗: {e}"))?,
            None,
            None,
        ),
        RecordTarget::Region { abs, crop } => {
            (monitor_at((abs.0 + 1, abs.1 + 1))?, Some(crop), Some(abs))
        }
    };
    let mw = monitor.width().map_err(|e| e.to_string())?;
    let mh = monitor.height().map_err(|e| e.to_string())?;

    // 出力サイズと色形式を決める（H.264は偶数サイズ必須）
    // Decide output size and color format (H.264 needs even dimensions)
    let (out_w, out_h, color, crop) = match crop {
        Some(c) => {
            let x = c.x.min(mw.saturating_sub(2));
            let y = c.y.min(mh.saturating_sub(2));
            let w = (c.w.min(mw - x)) & !1;
            let h = (c.h.min(mh - y)) & !1;
            let w = w.max(2);
            let h = h.max(2);
            (w, h, ColorFormat::Bgra8, Some(CropRect { x, y, w, h }))
        }
        None => (mw & !1, mh & !1, ColorFormat::Rgba8, None),
    };

    let dir = recordings_dir(app);
    std::fs::create_dir_all(&dir).map_err(|e| format!("保存先を作成できません: {e}"))?;
    let stamp = chrono::Local::now().format("%Y%m%d_%H%M%S");
    let path = dir.join(format!("auracap_rec_{stamp}.mp4"));

    let flags = RecordFlags {
        path: path.to_string_lossy().to_string(),
        out_w,
        out_h,
        crop,
    };
    let settings = Settings::new(
        monitor,
        CursorCaptureSettings::Default,
        // WGCの黄色枠はモニター全体に出るため無効化し、自前で選択矩形を囲む
        // Disable WGC's yellow border (it spans the whole monitor); we draw our own around the rect
        DrawBorderSettings::WithoutBorder,
        SecondaryWindowSettings::Default,
        // フレームレートを約30fpsに制限（高リフレッシュ環境でのCPU/メモリ負荷を抑える）
        // Cap to ~30fps to curb CPU/memory load on high-refresh displays
        MinimumUpdateIntervalSettings::Custom(Duration::from_millis(33)),
        DirtyRegionSettings::Default,
        color,
        flags,
    );

    let control =
        Recorder::start_free_threaded(settings).map_err(|e| format!("録画開始に失敗: {e}"))?;
    *state.0.lock().unwrap() = Some(Active {
        control,
        path: path.clone(),
        has_frame: abs.is_some(),
    });
    // 領域録画なら選択矩形を黄色枠で囲む / Draw the yellow frame around the rect for region recording
    if let Some((ax, ay)) = abs {
        show_rec_frame(app, ax, ay, out_w, out_h);
    }
    let _ = app.emit("recording-state", true);
    Ok(path.to_string_lossy().to_string())
}

/// 遅延後に録画を開始する（別スレッド）。停止できるよう開始後にメイン窓を表示する。
/// Start recording after a delay (background thread); re-show the main window so it can be stopped.
fn start_delayed(app: &AppHandle, target: RecordTarget, delay_secs: u32) {
    let app = app.clone();
    std::thread::spawn(move || {
        if delay_secs > 0 {
            std::thread::sleep(Duration::from_secs(delay_secs as u64));
        }
        match begin_recording(&app, target) {
            Ok(_) => {
                // 停止ボタンを使えるようメイン窓を再表示 / Re-show main so the Stop button is reachable
                if let Some(m) = app.get_webview_window("main") {
                    let _ = m.show();
                }
            }
            Err(e) => {
                eprintln!("[auracap] recording failed: {e}");
                let _ = app.emit("recording-error", e);
            }
        }
    });
}

/// 全画面録画を遅延付きで開始 / Start a fullscreen recording with a delay
pub fn start_fullscreen_recording(app: &AppHandle, delay_secs: u32) {
    start_delayed(app, RecordTarget::Fullscreen, delay_secs);
}

/// 領域録画を遅延付きで開始。abs は矩形の絶対座標、矩形(x,y,w,h)はモニター基準。
/// Start a region recording with a delay. `abs` is the rect's absolute origin; (x,y,w,h) is monitor-relative.
pub fn start_region_recording(
    app: &AppHandle,
    abs: (i32, i32),
    x: u32,
    y: u32,
    w: u32,
    h: u32,
    delay_secs: u32,
) {
    start_delayed(
        app,
        RecordTarget::Region {
            abs,
            crop: CropRect { x, y, w, h },
        },
        delay_secs,
    );
}

/// 全画面録画を即時開始（カウントダウン/遅延なし）/ Start fullscreen recording immediately
#[tauri::command]
pub fn start_recording(app: AppHandle, delay: Option<u32>) {
    start_fullscreen_recording(&app, delay.unwrap_or(0));
}

/// 録画を停止し、保存したMP4のパスを返す / Stop recording and return the saved MP4 path
#[tauri::command]
pub fn stop_recording(app: AppHandle) -> Result<String, String> {
    let state = app.state::<RecorderState>();
    let active = state.0.lock().unwrap().take();
    let Some(active) = active else {
        return Err("録画していません / not recording".into());
    };
    let path = active.path.to_string_lossy().to_string();
    // 黄色枠バーを閉じる / Close the yellow frame bars
    if active.has_frame {
        hide_rec_frame(&app);
    }
    // 停止するとセッションが閉じ、on_closed で MP4 が確定する / Stopping closes the session; on_closed finalizes the file
    active
        .control
        .stop()
        .map_err(|e| format!("録画停止に失敗: {e}"))?;
    let _ = app.emit("recording-state", false);
    Ok(path)
}

/// 録画中かどうか / Whether a recording is in progress
#[tauri::command]
pub fn is_recording(app: AppHandle) -> bool {
    app.state::<RecorderState>().0.lock().unwrap().is_some()
}
