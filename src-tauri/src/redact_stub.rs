// Smart Redact（OCR）のmacOS向けスタブ。実体（Windows標準OCR版）は redact.rs。
// Vision.frameworkベースの実装は別タスクとし、ここではフロントの呼び出しが
// 壊れないよう「未対応」を返すだけにする。
// macOS stub for Smart Redact (OCR). The real (Windows built-in OCR) implementation
// lives in redact.rs. A Vision.framework-based port is a separate task; this stub
// only keeps frontend calls from breaking by returning "unsupported".

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

const UNSUPPORTED: &str =
    "Smart Redact（OCR）は現在Windows版のみ対応しています / Smart Redact (OCR) is currently Windows-only";

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RedactRegion {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
    pub kind: String,
}

#[derive(Deserialize)]
pub struct OcrRect {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

#[tauri::command]
pub async fn detect_sensitive(_app: AppHandle) -> Result<Vec<RedactRegion>, String> {
    Err(UNSUPPORTED.into())
}

#[tauri::command]
pub async fn extract_text(_app: AppHandle, _rect: Option<OcrRect>) -> Result<String, String> {
    Err(UNSUPPORTED.into())
}
