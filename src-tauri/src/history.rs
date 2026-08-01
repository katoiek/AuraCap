// 履歴: 撮影した瞬間に無条件で自動保存されるPNGの保管場所（上限枚数で自動ローテーション）
// History: every capture is unconditionally auto-saved as PNG, rotated at a max count

use std::fs;
use std::path::PathBuf;

use chrono::Local;
use serde::Serialize;
use tauri::{AppHandle, Manager};
use xcap::image::RgbaImage;

type AnyError = Box<dyn std::error::Error>;

/// 履歴ブラウザ用のエントリ / A history entry for the in-app browser
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub path: String,
    pub name: String,
    /// "image"（PNG）または "video"（MP4）/ "image" (PNG) or "video" (MP4)
    pub kind: String,
}

/// 履歴を新しい順に列挙する（PNG静止画とMP4録画） / List history entries (PNG stills + MP4 recordings), newest first
#[tauri::command]
pub fn list_history(app: AppHandle, limit: Option<usize>) -> Result<Vec<HistoryEntry>, String> {
    let dir = history_dir(&app).map_err(|e| e.to_string())?;
    let mut paths: Vec<PathBuf> = fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.extension()
                .is_some_and(|ext| ext == "png" || ext == "mp4")
        })
        .collect();
    // ファイル名がタイムスタンプなので、降順ソート＝新しい順 / Timestamp names → desc = newest first
    paths.sort();
    paths.reverse();
    let limit = limit.unwrap_or(150);
    Ok(paths
        .into_iter()
        .take(limit)
        .map(|p| {
            let kind = if p.extension().is_some_and(|e| e == "mp4") {
                "video"
            } else {
                "image"
            };
            HistoryEntry {
                name: p
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                path: p.to_string_lossy().into_owned(),
                kind: kind.to_string(),
            }
        })
        .collect())
}

/// フロントから渡されたパスを履歴フォルダ内のファイルに限定して解決する。
/// 履歴の各コマンドは list_history / get_pending_recording が返したパスしか受け取らない前提なので、
/// それ以外（`..` を含む細工や無関係な絶対パス）はここで弾き、任意ファイルの読み取り・複製・削除を防ぐ。
/// Resolve a frontend-supplied path, confined to the history folder. These commands only ever
/// receive paths that list_history / get_pending_recording produced, so anything else (a crafted
/// `..`, an unrelated absolute path) is rejected here — no arbitrary file read/copy/delete.
pub fn resolve_in_history(app: &AppHandle, path: &str) -> Result<PathBuf, String> {
    let dir = history_dir(app)
        .and_then(|d| Ok(d.canonicalize()?))
        .map_err(|e| e.to_string())?;
    // canonicalizeはシンボリックリンクも解決するため、リンク経由の脱出も塞げる
    // canonicalize resolves symlinks too, so link-based escapes are covered
    let target = PathBuf::from(path)
        .canonicalize()
        .map_err(|_| "ファイルが見つかりません / file not found".to_string())?;
    if !target.starts_with(&dir) {
        return Err("履歴フォルダ外のファイルは操作できません / path outside the history folder".into());
    }
    Ok(target)
}

/// 履歴の画像をエディタで開く / Open a history image in the editor
#[tauri::command]
pub async fn edit_history(app: AppHandle, path: String) -> Result<(), String> {
    let path = resolve_in_history(&app, &path)?;
    let png = fs::read(&path).map_err(|e| e.to_string())?;
    let image = xcap::image::load_from_memory(&png)
        .map_err(|e| e.to_string())?
        .to_rgba8();
    crate::editor::open_editor(&app, &image);
    Ok(())
}

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
