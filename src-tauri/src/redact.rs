// Smart Redact: Windows標準OCRで画像内の文字を読み取り、
// 機密情報らしいパターン（メール・電話・カード番号・APIキー等）の領域を検出する。
// すべてローカル処理（外部API・ネットワーク送信なし）。
// Smart Redact: read on-image text with the built-in Windows OCR and detect
// regions that look sensitive (emails, phones, card numbers, API keys, ...).
// Fully local — no external APIs, nothing leaves the machine.

use std::sync::OnceLock;

use regex::Regex;
use serde::Serialize;
use tauri::{AppHandle, Manager};
use windows::Globalization::Language;
use windows::Graphics::Imaging::{BitmapPixelFormat, SoftwareBitmap};
use windows::Media::Ocr::OcrEngine;
use windows::Storage::Streams::DataWriter;
use xcap::image::{imageops, RgbaImage};

/// 検出された機密領域（画像ピクセル座標） / A detected sensitive region (image px)
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RedactRegion {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
    pub kind: String,
}

/// 検出パターン。誤検出はユーザーがぼかしを消せばよい設計なので、再現率優先
/// Detection patterns; recall-first since users can simply delete false positives
fn patterns() -> &'static Vec<(&'static str, Regex)> {
    static PATTERNS: OnceLock<Vec<(&'static str, Regex)>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        vec![
            (
                "メールアドレス",
                Regex::new(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}").unwrap(),
            ),
            (
                "電話番号",
                Regex::new(r"(?:\+81[\-\s]?|0)\d{1,4}[\-\s]?\d{1,4}[\-\s]?\d{3,4}").unwrap(),
            ),
            (
                "カード番号",
                Regex::new(r"\b\d{4}[\-\s]?\d{4}[\-\s]?\d{4}[\-\s]?\d{2,4}\b").unwrap(),
            ),
            (
                "APIキー/トークン",
                Regex::new(r"\b(?:sk|pk|ghp|gho|ghu|xox[bpoa]|AKIA|ASIA|AIza|ya29)[A-Za-z0-9_\-]{8,}")
                    .unwrap(),
            ),
            (
                "シークレット",
                Regex::new(r"(?i)(?:api[_\-]?key|secret|token|password|passwd|pwd|authorization)\s*[:=]\s*\S{6,}")
                    .unwrap(),
            ),
            (
                "IPアドレス",
                Regex::new(r"\b(?:\d{1,3}\.){3}\d{1,3}\b").unwrap(),
            ),
        ]
    })
}

/// 編集中の画像から機密領域を検出する / Detect sensitive regions in the edited image
/// OCRはブロッキングAPIのため専用スレッドで実行する（asyncコマンド + spawn_blocking）
/// OCR is blocking, so it runs on a worker thread (async command + spawn_blocking)
#[tauri::command]
pub async fn detect_sensitive(app: AppHandle) -> Result<Vec<RedactRegion>, String> {
    let bmp = app
        .state::<crate::editor::EditorImage>()
        .0
        .lock()
        .unwrap()
        .clone()
        .ok_or("編集中の画像がありません")?;
    tauri::async_runtime::spawn_blocking(move || detect(&bmp))
        .await
        .map_err(|e| e.to_string())?
}

fn detect(bmp: &[u8]) -> Result<Vec<RedactRegion>, String> {
    // WinRT呼び出しのためスレッドのCOMアパートメントを初期化（済みならS_FALSE）
    // Initialize the thread's COM apartment for WinRT (S_FALSE if already done)
    unsafe {
        use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};
        let _ = RoInitialize(RO_INIT_MULTITHREADED);
    }

    let image = xcap::image::load_from_memory(bmp)
        .map_err(|e| e.to_string())?
        .to_rgba8();

    let engine = create_engine()?;
    let max_dim = OcrEngine::MaxImageDimension().map_err(|e| e.to_string())? as u32;
    if image.width() > max_dim {
        return Err(format!("画像の幅がOCRの上限({max_dim}px)を超えています"));
    }

    // 縦長画像はOCR上限に合わせてチャンク分割（境界の取りこぼし防止に少し重ねる）
    // Tall images are split into chunks within the OCR limit (with overlap at seams)
    const OVERLAP: u32 = 80;
    let chunk_h = max_dim.min(image.height());
    let mut regions: Vec<RedactRegion> = Vec::new();
    let mut y0: u32 = 0;
    loop {
        let h = chunk_h.min(image.height() - y0);
        let chunk = imageops::crop_imm(&image, 0, y0, image.width(), h).to_image();
        for mut r in ocr_chunk(&engine, &chunk)? {
            r.y += y0 as f32;
            // チャンク重複部の二重検出を除去 / Drop duplicates from the overlap zone
            let dup = regions
                .iter()
                .any(|q| (q.x - r.x).abs() < 8.0 && (q.y - r.y).abs() < 8.0);
            if !dup {
                regions.push(r);
            }
        }
        if y0 + h >= image.height() {
            break;
        }
        y0 += chunk_h - OVERLAP;
    }
    eprintln!("[auracap] redact: detected {} region(s)", regions.len());
    Ok(regions)
}

fn create_engine() -> Result<OcrEngine, String> {
    // ユーザーの言語設定から生成。だめなら日本語→英語の順で試す
    // From the user's profile languages, falling back to Japanese then English
    if let Ok(engine) = OcrEngine::TryCreateFromUserProfileLanguages() {
        return Ok(engine);
    }
    for tag in ["ja", "en-US"] {
        if let Ok(lang) = Language::CreateLanguage(&tag.into()) {
            if let Ok(engine) = OcrEngine::TryCreateFromLanguage(&lang) {
                return Ok(engine);
            }
        }
    }
    Err("OCRエンジンを初期化できません（言語パックが必要な可能性があります）".into())
}

/// 1チャンクをOCRし、パターンに合致した単語群の外接矩形を返す
/// OCR one chunk and return bounding boxes of pattern-matching word groups
fn ocr_chunk(engine: &OcrEngine, chunk: &RgbaImage) -> Result<Vec<RedactRegion>, String> {
    let (w, h) = (chunk.width(), chunk.height());

    // RGBA → BGRA（SoftwareBitmapの要求フォーマット） / RGBA → BGRA for SoftwareBitmap
    let mut bgra = chunk.as_raw().clone();
    for px in bgra.chunks_exact_mut(4) {
        px.swap(0, 2);
    }
    let writer = DataWriter::new().map_err(|e| e.to_string())?;
    writer.WriteBytes(&bgra).map_err(|e| e.to_string())?;
    let buffer = writer.DetachBuffer().map_err(|e| e.to_string())?;
    let bitmap = SoftwareBitmap::CreateCopyFromBuffer(
        &buffer,
        BitmapPixelFormat::Bgra8,
        w as i32,
        h as i32,
    )
    .map_err(|e| e.to_string())?;

    // 非同期OCRの完了をポーリングで待つ（専用スレッド上なのでブロックしてよい）
    // Poll the async OCR to completion (we're on a worker thread, blocking is fine)
    let op = engine.RecognizeAsync(&bitmap).map_err(|e| e.to_string())?;
    // AsyncStatus::Started = 0（windows-futureの型を直接参照せず数値比較する）
    // AsyncStatus::Started = 0 (compared numerically to avoid the windows-future type path)
    while op.Status().map_err(|e| e.to_string())?.0 == 0 {
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    let result = op.GetResults().map_err(|e| e.to_string())?;

    let mut regions = Vec::new();
    for line in result.Lines().map_err(|e| e.to_string())? {
        // 行内の単語を連結し、各単語の文字範囲を記録してマッチ位置から逆引きする
        // Join the line's words, tracking each word's char range for reverse lookup
        let mut text = String::new();
        let mut spans: Vec<(usize, usize, windows::Foundation::Rect)> = Vec::new();
        for word in line.Words().map_err(|e| e.to_string())? {
            let t = word.Text().map_err(|e| e.to_string())?.to_string();
            let rect = word.BoundingRect().map_err(|e| e.to_string())?;
            if !text.is_empty() {
                text.push(' ');
            }
            let start = text.len();
            text.push_str(&t);
            spans.push((start, text.len(), rect));
        }

        for (kind, re) in patterns() {
            for m in re.find_iter(&text) {
                // マッチ範囲に重なる単語の矩形を合成する / Union rects of overlapping words
                let mut bounds: Option<(f32, f32, f32, f32)> = None;
                for (start, end, rect) in &spans {
                    if *end <= m.start() || *start >= m.end() {
                        continue;
                    }
                    let (l, t2, r, b) = (
                        rect.X,
                        rect.Y,
                        rect.X + rect.Width,
                        rect.Y + rect.Height,
                    );
                    bounds = Some(match bounds {
                        None => (l, t2, r, b),
                        Some((bl, bt, br, bb)) => (bl.min(l), bt.min(t2), br.max(r), bb.max(b)),
                    });
                }
                if let Some((l, t2, r, b)) = bounds {
                    // 少し余白を足して確実に覆う / Pad a little to fully cover
                    const PAD: f32 = 4.0;
                    regions.push(RedactRegion {
                        x: (l - PAD).max(0.0),
                        y: (t2 - PAD).max(0.0),
                        w: (r - l + PAD * 2.0).min(w as f32),
                        h: (b - t2 + PAD * 2.0).min(h as f32),
                        kind: kind.to_string(),
                    });
                }
            }
        }
    }
    Ok(regions)
}
