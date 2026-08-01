// Ollamaとの通信をRust側で行う（WebViewのfetchはCORSで弾かれるため）
// Talk to Ollama from Rust; the WebView's fetch is blocked by CORS (origin tauri.localhost)
use std::time::Duration;

/// URL末尾のスラッシュを除去し、空ならデフォルトを返す / Trim trailing slashes; fall back to default when empty
fn normalize_url(url: &str) -> String {
    let trimmed = url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        "http://127.0.0.1:11434".to_string()
    } else {
        trimmed.to_string()
    }
}

/// インストール済みモデル名の一覧を /api/tags から取得（名前順ソート）
/// Fetch installed model names from /api/tags (sorted)
#[tauri::command]
pub async fn ollama_list_models(url: String) -> Result<Vec<String>, String> {
    let base = normalize_url(&url);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    let res = client
        .get(format!("{base}/api/tags"))
        .send()
        .await
        .map_err(|e| format!("接続できません: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("status {}", res.status()));
    }
    let data: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
    let mut names: Vec<String> = data
        .get("models")
        .and_then(|m| m.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|m| m.get("name").and_then(|n| n.as_str()).map(String::from))
                .collect()
        })
        .unwrap_or_default();
    names.sort_by_key(|n| n.to_lowercase());
    Ok(names)
}

/// ビジョン対応モデルへ画像＋プロンプトを送り、生成テキストを返す / Send image+prompt to a vision model, return the generated text
#[tauri::command]
pub async fn ollama_generate(
    url: String,
    model: String,
    prompt: String,
    image_base64: String,
) -> Result<String, String> {
    let base = normalize_url(&url);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(600))
        .build()
        .map_err(|e| e.to_string())?;
    let body = serde_json::json!({
        "model": model,
        "stream": false,
        "messages": [{ "role": "user", "content": prompt, "images": [image_base64] }],
    });
    let res = client
        .post(format!("{base}/api/chat"))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("接続できません: {e}"))?;
    let status = res.status();
    if !status.is_success() {
        let text = res.text().await.unwrap_or_default();
        return Err(format!("Ollama {status}: {}", text.chars().take(200).collect::<String>()));
    }
    let data: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
    Ok(data
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or("")
        .to_string())
}
