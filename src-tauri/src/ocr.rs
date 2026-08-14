// テキスト抽出: Windows標準OCRで画像内の文字を読み取り、プレーンテキストとして返す。
// 完全ローカル処理（外部API・ネットワーク送信なし）。
// Text extraction: read on-image text with the built-in Windows OCR and return it as
// plain text. Fully local — no external APIs, nothing leaves the machine.

use serde::Deserialize;
use tauri::{AppHandle, Manager};
use windows::Globalization::Language;
use windows::Graphics::Imaging::{BitmapPixelFormat, SoftwareBitmap};
use windows::Media::Ocr::{OcrEngine, OcrResult};
use windows::Storage::Streams::DataWriter;
use xcap::image::{imageops, RgbaImage};

/// OCR範囲（画像ピクセル座標。指定時はこの矩形だけを読み取る）
/// OCR region (image px; when given, only this rectangle is read)
#[derive(Deserialize)]
pub struct OcrRect {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

/// 編集中の画像（または指定範囲）から文字を読み取ってプレーンテキストで返す
/// Read the text in the edited image (or a sub-region) and return it as plain text
#[tauri::command]
pub async fn extract_text(app: AppHandle, rect: Option<OcrRect>) -> Result<String, String> {
    let bmp = app
        .state::<crate::editor::EditorImage>()
        .0
        .lock()
        .unwrap()
        .clone()
        .ok_or("編集中の画像がありません")?;
    tauri::async_runtime::spawn_blocking(move || extract(&bmp, rect))
        .await
        .map_err(|e| e.to_string())?
}

fn extract(bmp: &[u8], rect: Option<OcrRect>) -> Result<String, String> {
    unsafe {
        use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};
        let _ = RoInitialize(RO_INIT_MULTITHREADED);
    }

    let mut image = xcap::image::load_from_memory(bmp)
        .map_err(|e| e.to_string())?
        .to_rgba8();

    // 範囲指定があればその矩形だけを切り出してOCRする。
    // グリフの上下端が欠けないよう、OCR時だけ少し余白を足して切り出す。
    // Crop to the region if given, padding a little so glyph edges aren't clipped.
    if let Some(r) = rect {
        const PAD: f32 = 8.0;
        let x0 = (r.x - PAD).max(0.0);
        let y0 = (r.y - PAD).max(0.0);
        let x1 = (r.x + r.w + PAD).min(image.width() as f32);
        let y1 = (r.y + r.h + PAD).min(image.height() as f32);
        let x = x0 as u32;
        let y = y0 as u32;
        let w = ((x1 - x0) as u32).max(1).min(image.width() - x);
        let h = ((y1 - y0) as u32).max(1).min(image.height() - y);
        image = imageops::crop_imm(&image, x, y, w, h).to_image();
    }

    let engine = create_engine()?;
    let max_dim = OcrEngine::MaxImageDimension().map_err(|e| e.to_string())?;
    if image.width() > max_dim {
        return Err(format!("画像の幅がOCRの上限({max_dim}px)を超えています"));
    }

    // 小さい領域は解像度不足で認識率が落ちるため拡大する（OCR上限を超えない範囲で）
    // Upscale small regions (low pixel count hurts recognition), capped to the OCR limit
    let min_dim = image.width().min(image.height());
    if min_dim > 0 && min_dim < 64 {
        let mut factor = (64 / min_dim).clamp(2, 4);
        let max_side = image.width().max(image.height());
        while factor > 1 && max_side * factor > max_dim {
            factor -= 1;
        }
        if factor > 1 {
            image = imageops::resize(
                &image,
                image.width() * factor,
                image.height() * factor,
                imageops::FilterType::Lanczos3,
            );
            eprintln!("[auracap] ocr: upscaled small region x{factor}");
        }
    }

    // 縦長画像はチャンク分割。テキストは重複回避のため重ねず順に連結する
    // Tall images are chunked; for text we don't overlap, just concatenate in order
    let chunk_h = max_dim.min(image.height());
    let mut lines: Vec<String> = Vec::new();
    let mut y0: u32 = 0;
    loop {
        let h = chunk_h.min(image.height() - y0);
        let chunk = imageops::crop_imm(&image, 0, y0, image.width(), h).to_image();
        lines.extend(ocr_text_lines(&engine, &chunk)?);
        if y0 + h >= image.height() {
            break;
        }
        y0 += chunk_h;
    }
    eprintln!("[auracap] ocr: extracted {} line(s)", lines.len());
    Ok(lines.join("\n"))
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

/// 1チャンクをOCRしてOcrResultを返す（ビットマップ生成＋同期待ち）
/// OCR one chunk and return the OcrResult (bitmap build + sync wait)
fn recognize(engine: &OcrEngine, chunk: &RgbaImage) -> Result<OcrResult, String> {
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
    op.GetResults().map_err(|e| e.to_string())
}

/// CJK（日本語・中国語・韓国語など字間にスペースを置かない文字）か
/// Whether the char is CJK (scripts that don't use inter-character spaces)
fn is_cjk(c: char) -> bool {
    matches!(c as u32,
        0x3000..=0x303F |   // CJK記号・句読点 / CJK symbols & punctuation
        0x3040..=0x30FF |   // ひらがな・カタカナ / Hiragana & Katakana
        0x3400..=0x4DBF |   // CJK拡張A / CJK ext A
        0x4E00..=0x9FFF |   // CJK統合漢字 / CJK unified
        0xAC00..=0xD7A3 |   // ハングル / Hangul
        0xF900..=0xFAFF |   // CJK互換漢字 / CJK compatibility
        0xFF00..=0xFFEF     // 全角・半角形 / Fullwidth & halfwidth forms
    )
}

/// 1チャンクの各行のテキストを返す / Return each line's text in a chunk
/// Windows OCRは単語単位で区切るため、日本語は1文字＝1単語になりがち。
/// 隣接文字の少なくとも一方がCJKならスペースを挿入しない（英単語間は維持）。
/// Windows OCR splits into words, so CJK becomes one word per glyph. Skip the
/// separating space when either adjacent char is CJK (keeps Latin word spacing).
fn ocr_text_lines(engine: &OcrEngine, chunk: &RgbaImage) -> Result<Vec<String>, String> {
    let result = recognize(engine, chunk)?;
    let mut lines = Vec::new();
    for line in result.Lines().map_err(|e| e.to_string())? {
        let mut text = String::new();
        let mut prev_last: Option<char> = None;
        for word in line.Words().map_err(|e| e.to_string())? {
            let w = word.Text().map_err(|e| e.to_string())?.to_string();
            let first = w.chars().next();
            if let (Some(p), Some(f)) = (prev_last, first) {
                if !is_cjk(p) && !is_cjk(f) {
                    text.push(' ');
                }
            }
            text.push_str(&w);
            prev_last = w.chars().last().or(prev_last);
        }
        lines.push(text);
    }
    Ok(lines)
}
