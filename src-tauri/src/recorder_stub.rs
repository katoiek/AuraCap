// 画面録画のmacOS向けスタブ。実体（Windows Graphics Capture版）は recorder.rs。
// ScreenCaptureKitベースの実装は別タスクとし、ここではフロントの呼び出しが
// 壊れないよう「未対応」を返すだけにする。
// macOS stub for screen recording. The real (Windows Graphics Capture) implementation
// lives in recorder.rs. A ScreenCaptureKit-based port is a separate task; this stub
// only keeps frontend calls from breaking by returning "unsupported".

use std::sync::Mutex;

use tauri::{AppHandle, Emitter};

const UNSUPPORTED: &str = "録画は現在Windows版のみ対応しています / recording is currently Windows-only";

#[derive(Default)]
pub struct RecorderState(pub Mutex<Option<()>>);

#[derive(Default)]
pub struct PendingRecording(pub Mutex<Option<String>>);

pub fn pre_create_video_editor(_app: &AppHandle) {}

pub fn pre_create_rec_frame(_app: &AppHandle) {}

pub fn start_fullscreen_recording(app: &AppHandle, _delay_secs: u32) {
    let _ = app.emit("recording-error", UNSUPPORTED);
}

pub fn start_region_recording(
    app: &AppHandle,
    _abs: (i32, i32),
    _x: u32,
    _y: u32,
    _w: u32,
    _h: u32,
    _delay_secs: u32,
) {
    let _ = app.emit("recording-error", UNSUPPORTED);
}

#[tauri::command]
pub fn start_recording(app: AppHandle, _delay: Option<u32>) {
    let _ = app.emit("recording-error", UNSUPPORTED);
}

#[tauri::command]
pub fn stop_recording(_app: AppHandle) -> Result<String, String> {
    Err(UNSUPPORTED.into())
}

#[tauri::command]
pub fn is_recording(_app: AppHandle) -> bool {
    false
}

#[tauri::command]
pub fn save_recording(_app: AppHandle, _path: String) -> Result<(), String> {
    Err(UNSUPPORTED.into())
}

#[tauri::command]
pub fn discard_recording(_app: AppHandle, _path: String) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub fn get_pending_recording(_app: AppHandle) -> Option<String> {
    None
}

#[tauri::command]
pub fn close_video_editor(_app: AppHandle) {}
