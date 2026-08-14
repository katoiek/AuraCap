// テキスト抽出（OCR）のmacOS向けスタブ。実体（Windows標準OCR版）は ocr.rs。
// Vision.frameworkベースの実装は別タスクとし、ここではフロントの呼び出しが
// 壊れないよう「未対応」を返すだけにする。
// macOS stub for text extraction (OCR). The real (Windows built-in OCR) implementation
// lives in ocr.rs. A Vision.framework-based port is a separate task; this stub
// only keeps frontend calls from breaking by returning "unsupported".

use serde::Deserialize;
use tauri::AppHandle;

const UNSUPPORTED: &str =
    "テキスト抽出（OCR）は現在Windows版のみ対応しています / Text extraction (OCR) is currently Windows-only";

#[derive(Deserialize)]
pub struct OcrRect {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

#[tauri::command]
pub async fn extract_text(_app: AppHandle, _rect: Option<OcrRect>) -> Result<String, String> {
    Err(UNSUPPORTED.into())
}
