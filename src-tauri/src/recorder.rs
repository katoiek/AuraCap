// 画面録画：Windowsは Windows Graphics Capture (WGC) 、macOSは ScreenCaptureKit の
// SCRecordingOutput（ハードウェアエンコードで直接MP4へ書き出す）でモニターを取得する。
// 全画面はモニターそのまま、領域録画はモニター内の矩形だけを対象にする。
// ウィンドウ管理・保存/破棄まわりはOS非依存の共通コード。
// Screen recording: Windows uses Windows Graphics Capture (WGC); macOS uses ScreenCaptureKit's
// SCRecordingOutput (hardware-encodes straight to MP4). Fullscreen records the whole monitor;
// region recording targets just a rectangle within it. Window management and save/discard are
// shared, OS-independent code.

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use tauri::{
    AppHandle, Emitter, EventTarget, Manager, PhysicalPosition, PhysicalSize, WebviewUrl,
    WebviewWindowBuilder,
};
use tauri_plugin_dialog::DialogExt;

#[cfg(windows)]
use std::time::Instant;
#[cfg(windows)]
use windows::Win32::Foundation::POINT;
#[cfg(windows)]
use windows::Win32::Graphics::Gdi::{MonitorFromPoint, MONITOR_DEFAULTTONEAREST};
#[cfg(windows)]
use windows_capture::capture::{CaptureControl, Context, GraphicsCaptureApiHandler};
#[cfg(windows)]
use windows_capture::encoder::{
    AudioSettingsBuilder, ContainerSettingsBuilder, VideoEncoder, VideoSettingsBuilder,
};
#[cfg(windows)]
use windows_capture::frame::Frame;
#[cfg(windows)]
use windows_capture::graphics_capture_api::InternalCaptureControl;
#[cfg(windows)]
use windows_capture::monitor::Monitor;
#[cfg(windows)]
use windows_capture::settings::{
    ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
    MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
};

#[cfg(target_os = "macos")]
use screencapturekit::prelude::*;
#[cfg(target_os = "macos")]
use screencapturekit::recording_output::{
    RecordingCallbacks, SCRecordingOutput, SCRecordingOutputCodec, SCRecordingOutputConfiguration,
};

#[cfg(windows)]
type RecError = Box<dyn std::error::Error + Send + Sync>;

/// クロップ矩形（モニター左上基準・物理px・偶数整列済み）/ Crop rect (monitor-relative, physical px, even-aligned)
#[derive(Clone, Copy)]
pub struct CropRect {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

// ============================================================
// Windows: Windows Graphics Capture エンジン
// Windows: Windows Graphics Capture engine
// ============================================================

/// 録画開始時にハンドラへ渡す情報 / Passed to the handler on start
#[cfg(windows)]
#[derive(Clone)]
pub struct RecordFlags {
    path: String,
    out_w: u32,
    out_h: u32,
    crop: Option<CropRect>,
}

/// WGCのフレームを受け取りエンコーダへ流すハンドラ / Receives WGC frames and feeds the encoder
#[cfg(windows)]
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

#[cfg(windows)]
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

#[cfg(windows)]
type RecControl = CaptureControl<Recorder, RecError>;

/// 絶対座標の点が乗っているモニターを取得 / Resolve the monitor that contains an absolute point
#[cfg(windows)]
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
    Ok(Monitor::from_raw_hmonitor(hmon.0))
}

/// 録画を開始する。Fullscreen で全画面、Region でそのモニターの矩形のみ。保存先パスを返す。
/// Begin recording. Fullscreen records the primary monitor; Region records only that rectangle.
#[cfg(windows)]
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
    // 履歴と時系列で並ぶよう静止画と同じ命名規則（auracap_<日時>）にする
    // Same naming as stills (auracap_<timestamp>) so it sorts chronologically in history
    let stamp = chrono::Local::now().format("%Y%m%d_%H%M%S");
    let path = dir.join(format!("auracap_{stamp}.mp4"));

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

// ============================================================
// macOS: ScreenCaptureKit エンジン
// macOS: ScreenCaptureKit engine
// ============================================================

/// 録画を開始する。Fullscreen で全画面、Region でそのモニターの矩形のみ。保存先パスを返す。
/// Begin recording. Fullscreen records the primary monitor; Region records only that rectangle.
#[cfg(target_os = "macos")]
fn begin_recording(app: &AppHandle, target: RecordTarget) -> Result<String, String> {
    let state = app.state::<RecorderState>();
    if state.0.lock().unwrap().is_some() {
        return Err("既に録画中です / already recording".into());
    }

    // 録画対象のモニターと、矩形の絶対座標（黄色枠用）/ Target monitor and the rect's absolute origin (for the frame)
    let (monitor, crop, abs) = match target {
        RecordTarget::Fullscreen => {
            let m = xcap::Monitor::all()
                .map_err(|e| e.to_string())?
                .into_iter()
                .find(|m| m.is_primary().unwrap_or(false))
                .ok_or("プライマリモニターが見つかりません / primary monitor not found")?;
            (m, None, None)
        }
        RecordTarget::Region { abs, crop } => {
            let m = xcap::Monitor::from_point(abs.0 + 1, abs.1 + 1).map_err(|e| e.to_string())?;
            (m, Some(crop), Some(abs))
        }
    };

    // xcapのMonitor寸法・スケールから物理pxの実寸を出す（他のmacOS対応箇所と同じ変換）
    // Derive physical-px dimensions from xcap's monitor size & scale (same conversion used elsewhere for macOS)
    let scale = monitor.scale_factor().map_err(|e| e.to_string())?;
    let mw = (monitor.width().map_err(|e| e.to_string())? as f32 * scale).round() as u32;
    let mh = (monitor.height().map_err(|e| e.to_string())? as f32 * scale).round() as u32;
    let display_id = monitor.id().map_err(|e| e.to_string())?;

    // 出力サイズを決める（H.264は偶数サイズ必須）/ Decide output size (H.264 needs even dimensions)
    let (out_w, out_h, crop) = match crop {
        Some(c) => {
            let x = c.x.min(mw.saturating_sub(2));
            let y = c.y.min(mh.saturating_sub(2));
            let w = ((c.w.min(mw - x)) & !1).max(2);
            let h = ((c.h.min(mh - y)) & !1).max(2);
            (w, h, Some(CropRect { x, y, w, h }))
        }
        None => (mw & !1, mh & !1, None),
    };

    let dir = recordings_dir(app);
    std::fs::create_dir_all(&dir).map_err(|e| format!("保存先を作成できません: {e}"))?;
    // 履歴と時系列で並ぶよう静止画と同じ命名規則（auracap_<日時>）にする
    // Same naming as stills (auracap_<timestamp>) so it sorts chronologically in history
    let stamp = chrono::Local::now().format("%Y%m%d_%H%M%S");
    let path = dir.join(format!("auracap_{stamp}.mp4"));

    // ScreenCaptureKitのsource_rectはxcapと同じくディスプレイローカルのポイント単位
    // ScreenCaptureKit's source_rect is display-local points, same unit as xcap
    let source_rect = crop.map(|c| {
        CGRect::new(
            f64::from(c.x) / f64::from(scale),
            f64::from(c.y) / f64::from(scale),
            f64::from(c.w) / f64::from(scale),
            f64::from(c.h) / f64::from(scale),
        )
    });

    let content = SCShareableContent::get().map_err(|e| e.to_string())?;
    let display = content
        .displays()
        .into_iter()
        .find(|d| d.display_id() == display_id)
        .ok_or("対象ディスプレイが見つかりません / target display not found")?;
    let filter = SCContentFilter::create()
        .with_display(&display)
        .with_excluding_windows(&[])
        .build();
    let mut config = SCStreamConfiguration::new()
        .with_width(out_w)
        .with_height(out_h)
        .with_fps(30)
        .with_captures_audio(false)
        .with_shows_cursor(true);
    if let Some(rect) = source_rect {
        config = config.with_source_rect(rect);
    }

    let rec_config = SCRecordingOutputConfiguration::new()
        .with_output_url(&path)
        .with_video_codec(SCRecordingOutputCodec::H264);

    // 確定（recording_did_finish）は非同期コールバックで届くため、stop_recording側で
    // 同期的に待てるようチャンネルで橋渡しする
    // Finalization (recording_did_finish) arrives via an async callback; bridge it through a
    // channel so stop_recording can wait for it synchronously
    let (finish_tx, finish_rx) = std::sync::mpsc::channel::<Result<(), String>>();
    let fail_tx = finish_tx.clone();
    let delegate = RecordingCallbacks::new()
        .on_finish(move || {
            let _ = finish_tx.send(Ok(()));
        })
        .on_fail(move |e| {
            let _ = fail_tx.send(Err(e));
        });
    let recording_output = SCRecordingOutput::new_with_delegate(&rec_config, delegate)
        .ok_or("録画出力の作成に失敗 / failed to create recording output")?;

    let stream = SCStream::new(&filter, &config);
    stream
        .add_recording_output(&recording_output)
        .map_err(|e| format!("録画出力の追加に失敗: {e}"))?;
    stream
        .start_capture()
        .map_err(|e| format!("録画開始に失敗: {e}"))?;

    *state.0.lock().unwrap() = Some(Active {
        stream,
        recording_output,
        finish_rx,
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

// ============================================================
// 共通 / Shared
// ============================================================

/// 録画中の状態（停止用のハンドルと出力先を保持） / Active recording state
pub struct Active {
    #[cfg(windows)]
    control: RecControl,
    #[cfg(target_os = "macos")]
    stream: SCStream,
    #[cfg(target_os = "macos")]
    recording_output: SCRecordingOutput,
    #[cfg(target_os = "macos")]
    finish_rx: std::sync::mpsc::Receiver<Result<(), String>>,
    path: PathBuf,
    has_frame: bool,
}

#[derive(Default)]
pub struct RecorderState(pub Mutex<Option<Active>>);

/// 動画エディタ窓へ渡す、プレビュー対象の録画パス（履歴の一時MP4）
/// The recording path (temp MP4 in history) handed to the video editor window
#[derive(Default)]
pub struct PendingRecording(pub Mutex<Option<String>>);

/// 録画の一時保存先。静止画と同じ「履歴」フォルダに保存し、プレビューから保存/破棄させる。
/// Temp output for recordings: the same "History" folder as stills; the preview then saves/discards.
fn recordings_dir(app: &AppHandle) -> PathBuf {
    crate::history::history_dir(app).unwrap_or_else(|_| {
        app.path()
            .picture_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
    })
}

/// 録画対象 / What to record
pub enum RecordTarget {
    /// 全画面（プライマリモニター）/ Fullscreen (primary monitor)
    Fullscreen,
    /// 矩形録画。abs は矩形の絶対座標（物理px・モニター特定と黄色枠に使用）、crop はモニター基準
    /// Rectangle recording. `abs` is the rect's absolute origin (used to resolve the monitor and draw the frame); `crop` is monitor-relative
    Region { abs: (i32, i32), crop: CropRect },
}

/// 録画枠バー（4本）のウィンドウラベル / Window labels for the 4 frame bars
const FRAME_LABELS: [&str; 4] = ["recframe-0", "recframe-1", "recframe-2", "recframe-3"];
/// 枠の太さ（物理px）/ Border thickness (physical px)
const FRAME_THICK: i32 = 3;

/// カウントダウン窓のラベル / Window label for the countdown
const COUNTDOWN_LABEL: &str = "reccountdown";
/// カウントダウン窓の一辺（物理px）。枠がこれより小さければ枠に合わせて縮める
/// Countdown window side length (physical px); shrunk to fit when the frame is smaller
const COUNTDOWN_SIZE: u32 = 180;
/// 窓を隠してから画面合成（DWM）に反映されるまでの猶予。
/// カウントダウンは選択範囲の内側に出るため、これを待たずに録画を始めると
/// 最初の数フレームに数字が写り込む。capture.rs のウィンドウ退避待ちと同じ理由。
/// Grace period for a hidden window to leave DWM composition. The countdown sits *inside* the
/// recorded rect, so starting capture without this bakes the digit into the first frames.
/// Same reasoning as the window-hide wait in capture.rs.
const HIDE_SETTLE_MS: u64 = 200;

/// 枠バー窓を生成（不透明・隠し）。中身はテーマ色のdiv（recframe）。
/// Create a frame-bar window (opaque, hidden); content is a themed solid div (recframe).
fn create_rec_frame_window(app: &AppHandle, label: &str) -> Result<tauri::WebviewWindow, String> {
    WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html?recframe=1".into()))
        .title("AuraCap")
        .decorations(false)
        .resizable(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .focused(false)
        .shadow(false)
        .visible(false)
        // 描画前のちらつき防止の暗色。実際の色はdiv(var(--accent))で塗る。
        // Dark pre-paint color; the actual color is painted by the div (var(--accent)).
        .background_color(tauri::window::Color(24, 24, 27, 255))
        .build()
        .map_err(|e| e.to_string())
}

/// カウントダウン窓を生成（透過・隠し）。中身は数字だけを描く円形バッジ。
/// Create the countdown window (transparent, hidden); it paints a circular badge with the digit.
fn create_countdown_window(app: &AppHandle) -> Result<tauri::WebviewWindow, String> {
    WebviewWindowBuilder::new(
        app,
        COUNTDOWN_LABEL,
        WebviewUrl::App("index.html?countdown=1".into()),
    )
    .title("AuraCap")
    .decorations(false)
    .resizable(false)
    .skip_taskbar(true)
    .always_on_top(true)
    .focused(false)
    .shadow(false)
    .visible(false)
    // 角を丸く見せるため窓自体は透過にする / Transparent so the badge can look round
    .transparent(true)
    .build()
    .map_err(|e| e.to_string())
}

/// 起動時に録画表示用の常駐窓（枠バー4本＋カウントダウン）を事前生成する
/// （録画毎の生成を避け高速化）
/// Pre-create the resident recording-overlay windows (4 frame bars + countdown) at startup,
/// avoiding per-recording creation.
pub fn pre_create_rec_overlays(app: &AppHandle) {
    for label in FRAME_LABELS {
        if app.get_webview_window(label).is_none() {
            if let Err(e) = create_rec_frame_window(app, label) {
                eprintln!("[auracap] failed to pre-create rec frame {label}: {e}");
            }
        }
    }
    if app.get_webview_window(COUNTDOWN_LABEL).is_none() {
        if let Err(e) = create_countdown_window(app) {
            eprintln!("[auracap] failed to pre-create countdown window: {e}");
        }
    }
}

/// 選択矩形の外側に枠（テーマ色）を表示する。常駐窓を再配置して使い回す。
/// Show a themed frame just outside the rect by repositioning the resident bar windows.
fn show_rec_frame(app: &AppHandle, abs_x: i32, abs_y: i32, w: u32, h: u32) {
    let t = FRAME_THICK;
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
            let win = match app.get_webview_window(label) {
                Some(w) => w,
                None => match create_rec_frame_window(&app, label) {
                    Ok(w) => w,
                    Err(e) => {
                        eprintln!("[auracap] rec frame {label} create failed: {e}");
                        continue;
                    }
                },
            };
            let _ = win.set_position(PhysicalPosition::new(*rx, *ry));
            let _ = win.set_size(PhysicalSize::new(*rw, *rh));
            let _ = win.set_ignore_cursor_events(true);
            let _ = win.show();
        }
    });
}

/// 録画枠を隠す（窓は常駐・使い回し）/ Hide the frame bars (kept resident)
fn hide_rec_frame(app: &AppHandle) {
    let app = app.clone();
    let _ = app.clone().run_on_main_thread(move || {
        for label in FRAME_LABELS {
            if let Some(w) = app.get_webview_window(label) {
                let _ = w.hide();
            }
        }
    });
}

/// カウントダウンを選択枠の中央に出す / Place the countdown at the center of the selected rect
fn show_countdown(app: &AppHandle, (x, y, w, h): (i32, i32, u32, u32)) {
    // 枠からはみ出さないよう一辺を詰める（小さい範囲を録るときの見切れ防止）
    // Shrink the badge so it never spills out of a small selection
    let size = COUNTDOWN_SIZE.min(w).min(h).max(48);
    let cx = x + (w as i32 - size as i32) / 2;
    let cy = y + (h as i32 - size as i32) / 2;
    let app = app.clone();
    let _ = app.clone().run_on_main_thread(move || {
        let win = match app.get_webview_window(COUNTDOWN_LABEL) {
            Some(w) => w,
            None => match create_countdown_window(&app) {
                Ok(w) => w,
                Err(e) => {
                    eprintln!("[auracap] countdown create failed: {e}");
                    return;
                }
            },
        };
        let _ = win.set_size(PhysicalSize::new(size, size));
        let _ = win.set_position(PhysicalPosition::new(cx, cy));
        // 待機中に下のUIを触れなくならないよう当たり判定を抜く / Stay click-through while waiting
        let _ = win.set_ignore_cursor_events(true);
        let _ = win.show();
    });
}

fn hide_countdown(app: &AppHandle) {
    let app = app.clone();
    let _ = app.clone().run_on_main_thread(move || {
        if let Some(w) = app.get_webview_window(COUNTDOWN_LABEL) {
            let _ = w.hide();
        }
    });
}

/// 録画開始までの残り秒数を枠の中央に出す。呼び出しから戻るまでちょうど `secs` 秒かかる。
/// 秒の刻みはフロント側のタイマーに任せ、ここでは開始の合図を1回送るだけにする
/// （毎秒emitする方式だと、1つでも取りこぼすと表示がそこで止まってしまうため）。
/// Show the remaining seconds at the center of the frame; returns after exactly `secs` seconds.
/// The per-second ticking is left to a timer in the frontend and only a single start signal is
/// sent — emitting every second means one dropped event freezes the display.
fn run_countdown(app: &AppHandle, rect: (i32, i32, u32, u32), secs: u32) {
    show_countdown(app, rect);
    let _ = app.emit_to(
        EventTarget::labeled(COUNTDOWN_LABEL),
        "countdown-start",
        secs,
    );
    // 窓を畳んで合成から消えるまでの猶予を待ち時間の内側で消化する。
    // こうすると待ち時間の合計は secs のままで、かつ数字が録画に写り込まない。
    // Spend the hide-settle grace inside the wait: the total stays exactly `secs` while
    // guaranteeing the digit has left the screen before capture starts.
    std::thread::sleep(Duration::from_millis(secs as u64 * 1000 - HIDE_SETTLE_MS));
    hide_countdown(app);
    std::thread::sleep(Duration::from_millis(HIDE_SETTLE_MS));
}

/// 遅延後に録画を開始する（別スレッド）。停止できるよう開始後にメイン窓を表示する。
/// 領域・ウィンドウ録画では、選択を確定した直後から枠を出したままにし、待機中は残り秒数を
/// 枠の中央に表示する。枠が消えていると「どこが録られるのか」も「あと何秒か」も分からないまま
/// 待たされることになるため。
/// Start recording after a delay (background thread); re-show the main window so it can be stopped.
/// For region/window recording the frame stays up from the moment the selection is confirmed, with
/// the remaining seconds shown at its center — otherwise the user waits with no idea what area was
/// chosen or how long is left.
fn start_delayed(app: &AppHandle, target: RecordTarget, delay_secs: u32) {
    // 枠を出す対象の矩形。全画面録画に枠は無いのでNone / The rect to frame; fullscreen has no frame
    let framed = match &target {
        RecordTarget::Region { abs, crop } => Some((abs.0, abs.1, crop.w, crop.h)),
        RecordTarget::Fullscreen => None,
    };
    if let Some((x, y, w, h)) = framed {
        show_rec_frame(app, x, y, w, h);
    }
    let app = app.clone();
    std::thread::spawn(move || {
        if delay_secs > 0 {
            match framed {
                Some(rect) => run_countdown(&app, rect, delay_secs),
                None => std::thread::sleep(Duration::from_secs(delay_secs as u64)),
            }
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
                // 先に出した枠が画面に残り続けないよう畳む / Take down the frame we put up in advance
                if framed.is_some() {
                    hide_rec_frame(&app);
                    hide_countdown(&app);
                }
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
    // 停止するとセッションが閉じ、MP4 が確定する / Stopping closes the session and finalizes the file
    #[cfg(windows)]
    active
        .control
        .stop()
        .map_err(|e| format!("録画停止に失敗: {e}"))?;
    #[cfg(target_os = "macos")]
    {
        active
            .stream
            .stop_capture()
            .map_err(|e| format!("録画停止に失敗: {e}"))?;
        let _ = active.stream.remove_recording_output(&active.recording_output);
        // ファイルへの確定（recording_did_finish）を待つ。タイムアウトしても
        // 大抵は書き出し済みなので、警告のみでプレビューは開く。
        // Wait for the file to finalize (recording_did_finish). If it times out, the file is
        // usually already written, so just warn and still open the preview.
        match active.finish_rx.recv_timeout(Duration::from_secs(10)) {
            Ok(Ok(())) => {}
            Ok(Err(e)) => eprintln!("[auracap] recording finished with error: {e}"),
            Err(_) => eprintln!("[auracap] recording finish callback timed out"),
        }
    }
    let _ = app.emit("recording-state", false);
    // 静止画のエディタと同様、別ウィンドウのプレビューで保存/破棄させる
    // Like the still editor, open the clip in a separate preview window to save/discard
    open_video_editor(&app, &path);
    Ok(path)
}

/// 動画プレビュー/エディタ窓を作る（常駐・使い回し）。将来の動画エディタの土台。
/// Create the video preview/editor window (resident & reused). Foundation for a future video editor.
fn create_video_window(app: &AppHandle) -> Result<tauri::WebviewWindow, String> {
    WebviewWindowBuilder::new(
        app,
        "video-editor",
        WebviewUrl::App("index.html?video=1".into()),
    )
    .title("AuraCap — 録画")
    .visible(false)
    .resizable(true)
    // 白フラッシュ防止 / Avoid white flash before first paint
    .background_color(tauri::window::Color(24, 24, 27, 255))
    .build()
    .map_err(|e| e.to_string())
}

/// 起動時に動画プレビュー窓を事前生成して隠し常駐させる（初回表示の高速化）
/// Pre-create the hidden video preview window at startup (fast first open)
pub fn pre_create_video_editor(app: &AppHandle) {
    if app.get_webview_window("video-editor").is_none() {
        if let Err(e) = create_video_window(app) {
            eprintln!("[auracap] failed to pre-create video window: {e}");
        }
    }
}

/// 録画（履歴の一時MP4）をプレビュー窓で開く / Open a recording in the preview window
pub fn open_video_editor(app: &AppHandle, path: &str) {
    if let Some(state) = app.try_state::<PendingRecording>() {
        *state.0.lock().unwrap() = Some(path.to_string());
    }
    let app = app.clone();
    let path = path.to_string();
    let _ = app.clone().run_on_main_thread(move || {
        let window = match app.get_webview_window("video-editor") {
            Some(w) => w,
            None => match create_video_window(&app) {
                Ok(w) => w,
                Err(e) => {
                    eprintln!("[auracap] failed to create video window: {e}");
                    return;
                }
            },
        };
        // モニターの約半分のサイズに / Size to ~half the monitor
        if let Ok(Some(m)) = window.current_monitor() {
            let w = ((m.size().width as f64 * 0.5) as u32).max(480);
            let h = ((m.size().height as f64 * 0.6) as u32).max(360);
            let _ = window.set_size(PhysicalSize::new(w, h));
            let _ = window.center();
        }
        // 使い回し窓へ最新パスを通知 / Tell the reused window about the latest path
        let _ = app.emit_to(EventTarget::labeled("video-editor"), "video-open", path.clone());
        let _ = window.show();
        let _ = window.set_focus();
    });
}

/// プレビュー対象の録画パスを取得（窓の初回表示用）/ Get the pending recording path (for the window's first load)
#[tauri::command]
pub fn get_pending_recording(app: AppHandle) -> Option<String> {
    app.try_state::<PendingRecording>()
        .and_then(|s| s.0.lock().unwrap().clone())
}

/// 動画プレビュー窓を閉じる（隠して使い回す）/ Close the video preview window (hide & reuse)
#[tauri::command]
pub fn close_video_editor(app: AppHandle) {
    if let Some(w) = app.get_webview_window("video-editor") {
        let _ = w.hide();
    }
    if let Some(s) = app.try_state::<PendingRecording>() {
        *s.0.lock().unwrap() = None;
    }
}

/// 録画中かどうか / Whether a recording is in progress
#[tauri::command]
pub fn is_recording(app: AppHandle) -> bool {
    app.state::<RecorderState>().0.lock().unwrap().is_some()
}

/// 録画（履歴の一時MP4）を保存先へ書き出す。静止画の export_save と同じ保存規則。
/// Export a recording (temp MP4 in history) to the save destination, mirroring still export_save.
#[tauri::command]
pub fn save_recording(app: AppHandle, path: String) -> Result<(), String> {
    let src = crate::history::resolve_in_history(&app, &path)?;
    if !src.is_file() {
        return Err("録画ファイルが見つかりません / recording not found".into());
    }
    let s = crate::settings::load(&app);
    let name = crate::editor::build_file_name(&s.file_name_template, "mp4");

    // 指定フォルダに即コピー（ダイアログ無し）/ Copy straight to the fixed folder, no dialog
    if s.save_mode == "fixed" {
        let dir = crate::editor::resolve_save_dir(&app, &s.save_dir);
        std::fs::create_dir_all(&dir).map_err(|e| format!("保存先を作成できません: {e}"))?;
        let dest = crate::editor::unique_path(&dir, &name);
        std::fs::copy(&src, &dest).map_err(|e| e.to_string())?;
        crate::editor::remember_save_dir(&app, &dir);
        let _ = app.emit("recording-saved", dest.to_string_lossy().to_string());
        return Ok(());
    }

    // ダイアログ（"last"は前回保存先・それ以外は既定を初期表示）/ Dialog (last folder for "last", else default)
    let initial = if s.save_mode == "last" && !s.last_save_dir.is_empty() {
        crate::editor::resolve_save_dir(&app, &s.last_save_dir)
    } else {
        crate::editor::resolve_save_dir(&app, &s.save_dir)
    };
    let app_cb = app.clone();
    let src_cb = src.clone();
    app.dialog()
        .file()
        .add_filter("動画", &["mp4"])
        .set_directory(initial)
        .set_file_name(&name)
        .save_file(move |chosen| {
            let Some(chosen) = chosen else { return }; // キャンセル / cancelled
            let dest = match chosen.into_path() {
                Ok(p) => p,
                Err(e) => {
                    eprintln!("[auracap] save_recording path error: {e}");
                    return;
                }
            };
            match std::fs::copy(&src_cb, &dest) {
                Ok(_) => {
                    if let Some(parent) = dest.parent() {
                        crate::editor::remember_save_dir(&app_cb, parent);
                    }
                    let _ = app_cb.emit("recording-saved", dest.to_string_lossy().to_string());
                }
                Err(e) => eprintln!("[auracap] save_recording copy failed: {e}"),
            }
        });
    Ok(())
}

/// 録画（履歴の一時MP4）を破棄（削除）する / Discard (delete) a recording from history
#[tauri::command]
pub fn discard_recording(app: AppHandle, path: String) -> Result<(), String> {
    let p = crate::history::resolve_in_history(&app, &path)?;
    if p.is_file() {
        std::fs::remove_file(&p).map_err(|e| e.to_string())?;
    }
    Ok(())
}
