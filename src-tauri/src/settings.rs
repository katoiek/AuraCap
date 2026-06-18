// ユーザー設定の読み書き。app_config_dir/settings.json にJSONで永続化する
// User settings persistence: JSON at app_config_dir/settings.json

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// ホットキーはtauri-plugin-global-shortcutが解釈する文字列で保持する
/// （例: "PrintScreen", "Ctrl+PrintScreen", "Ctrl+Shift+KeyA"）
/// Hotkeys are stored as strings understood by tauri-plugin-global-shortcut
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// ✕ボタンの動作。true=トレイに常駐（隠す）/ false=アプリを終了
    /// Close-button behavior. true = hide to tray, false = quit the app
    pub close_to_tray: bool,
    /// グローバルホットキーを使うか（OFFなら一切登録しない＝他アプリと競合しない）
    /// Whether to use global hotkeys (OFF registers none, avoiding conflicts)
    pub hotkeys_enabled: bool,
    pub hotkey_region: String,
    pub hotkey_window: String,
    pub hotkey_fullscreen: String,
    /// Screenshot-to-Code用のClaude APIキー（ローカル保存・個人用ツールの割り切り）
    /// Claude API key for Screenshot-to-Code (stored locally; personal-tool tradeoff)
    pub anthropic_api_key: String,
    /// コード生成エンジン: "claude" または "ollama" / Codegen engine: "claude" or "ollama"
    pub codegen_provider: String,
    /// OllamaのエンドポイントURL / Ollama endpoint URL
    pub ollama_url: String,
    /// Ollamaのビジョン対応モデル名 / Ollama vision-capable model name
    pub ollama_model: String,
    /// 保存先の決め方: "ask"=毎回ダイアログ / "fixed"=指定フォルダに即保存 / "last"=前回の場所を初期表示
    /// How the save destination is chosen: "ask" = dialog every time, "fixed" = save straight to save_dir, "last" = dialog starting at the last-used folder
    pub save_mode: String,
    /// 既定の保存先フォルダ。空ならピクチャ / Default save folder; empty means Pictures
    pub save_dir: String,
    /// 最後に保存したフォルダ（"last"モードと記憶用・自動更新）/ Last folder saved into (auto-updated; used by "last" mode)
    pub last_save_dir: String,
    /// 手動保存時のファイル名テンプレート。{date}{time}{YYYY}{MM}{DD}{HH}{mm}{ss} を展開（拡張子は自動付与）
    /// File-name template for manual saves; expands {date}{time}{YYYY}{MM}{DD}{HH}{mm}{ss} (extension auto-appended)
    pub file_name_template: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            close_to_tray: true,
            hotkeys_enabled: true,
            hotkey_region: "PrintScreen".into(),
            hotkey_window: "Ctrl+PrintScreen".into(),
            hotkey_fullscreen: "Shift+PrintScreen".into(),
            anthropic_api_key: String::new(),
            codegen_provider: "claude".into(),
            ollama_url: "http://127.0.0.1:11434".into(),
            ollama_model: "qwen2.5vl".into(),
            save_mode: "ask".into(),
            save_dir: String::new(),
            last_save_dir: String::new(),
            file_name_template: "auracap_{date}_{time}".into(),
        }
    }
}

#[derive(Default)]
pub struct SettingsState(pub Mutex<Settings>);

fn settings_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join("settings.json"))
}

/// 設定ファイルを読む。壊れている・存在しない場合は既定値
/// Load settings; fall back to defaults if missing or corrupted
pub fn load(app: &AppHandle) -> Settings {
    settings_path(app)
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    let path = settings_path(app).ok_or("設定フォルダを解決できません / config dir unavailable")?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())
}
