// 履歴: 撮影した瞬間に無条件で自動保存されるPNGの保管場所（上限枚数で自動ローテーション）
// History: every capture is unconditionally auto-saved as PNG, rotated at a max count

use std::fs;
use std::path::PathBuf;

use chrono::Local;
use tauri::{AppHandle, Manager};
use xcap::image::RgbaImage;

type AnyError = Box<dyn std::error::Error>;

/// 履歴の上限枚数 / Maximum number of history entries
const MAX_HISTORY: usize = 500;

/// 履歴フォルダ（なければ作成） / History directory (created on demand)
pub fn history_dir(app: &AppHandle) -> Result<PathBuf, AnyError> {
    let dir = app.path().picture_dir()?.join("AuraCap").join("History");
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// 画像を履歴へ保存しローテーションする / Save an image to history and rotate
pub fn save(app: &AppHandle, image: &RgbaImage) -> Result<PathBuf, AnyError> {
    let dir = history_dir(app)?;
    // タイムスタンプ命名なのでファイル名ソート＝時系列ソートになる
    // Timestamp naming makes filename order equal to chronological order
    let name = format!("auracap_{}.png", Local::now().format("%Y%m%d_%H%M%S_%3f"));
    let path = dir.join(name);
    image.save(&path)?;
    rotate(&dir)?;
    Ok(path)
}

fn rotate(dir: &PathBuf) -> Result<(), AnyError> {
    let mut entries: Vec<PathBuf> = fs::read_dir(dir)?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|ext| ext == "png"))
        .collect();
    if entries.len() <= MAX_HISTORY {
        return Ok(());
    }
    entries.sort();
    for old in &entries[..entries.len() - MAX_HISTORY] {
        let _ = fs::remove_file(old);
    }
    Ok(())
}
