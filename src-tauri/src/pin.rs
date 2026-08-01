// 付箋ピン留め：編集後の画像を常に最前面のフローティング窓としてデスクトップに貼り付ける
// Pin-to-desktop: show the edited image as an always-on-top floating window for reference

use std::collections::HashMap;
use std::sync::Mutex;

use tauri::ipc::InvokeBody;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

/// ピン画像（id→PNGバイト列）と採番カウンタ / Pinned images (id→PNG) and the id counter
#[derive(Default)]
pub struct PinState {
    pub images: Mutex<HashMap<u32, Vec<u8>>>,
    pub counter: Mutex<u32>,
}

/// 編集後のPNGを受け取り、付箋ウィンドウを生成する
/// Receive the edited PNG and spawn a pin window
/// 注意: ウィンドウ生成を伴うためasync必須（同期コマンドはデッドロックする）
/// NOTE: must be async (window creation in a sync command would deadlock)
/// PNGバイト列から付箋ウィンドウを生成する共通処理 / Shared: spawn a pin window from PNG bytes
fn spawn_pin(app: &AppHandle, png: Vec<u8>) -> Result<(), String> {
    // 表示サイズ算出のため画像サイズを取得 / Decode just for dimensions
    let (img_w, img_h) = {
        let img = xcap::image::load_from_memory(&png).map_err(|e| e.to_string())?;
        (img.width(), img.height())
    };

    let state = app.state::<PinState>();
    let id = {
        let mut c = state.counter.lock().unwrap();
        *c += 1;
        *c
    };
    state.images.lock().unwrap().insert(id, png);

    let app2 = app.clone();
    app.run_on_main_thread(move || {
        if let Err(e) = create_pin_window(&app2, id, img_w, img_h) {
            eprintln!("[auracap] failed to create pin window: {e}");
        }
    })
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn pin_image(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let png = match request.body() {
        InvokeBody::Raw(bytes) => bytes.clone(),
        _ => return Err("expected raw PNG bytes".into()),
    };
    spawn_pin(&app, png)
}

/// 履歴の画像を付箋として貼る / Pin a history image
#[tauri::command]
pub async fn pin_history(app: AppHandle, path: String) -> Result<(), String> {
    let path = crate::history::resolve_in_history(&app, &path)?;
    let png = std::fs::read(&path).map_err(|e| e.to_string())?;
    spawn_pin(&app, png)
}

fn create_pin_window(
    app: &AppHandle,
    id: u32,
    img_w: u32,
    img_h: u32,
) -> Result<(), Box<dyn std::error::Error>> {
    // 付箋は最大360pxに収める（縮小のみ） / Fit the pin within 360px (downscale only)
    let factor = (360.0 / img_w.max(img_h) as f64).min(1.0);
    let w = (img_w as f64 * factor).max(120.0);
    let h = (img_h as f64 * factor).max(80.0);
    // 複数の付箋が重ならないよう少しずつずらす / Cascade so multiple pins don't stack exactly
    let offset = (id % 8) as f64 * 28.0;

    WebviewWindowBuilder::new(
        app,
        format!("pin-{id}"),
        WebviewUrl::App(format!("index.html?pin={id}").into()),
    )
    .title("AuraCap Pin")
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(true)
    .inner_size(w, h)
    .position(80.0 + offset, 80.0 + offset)
    .build()?;
    Ok(())
}

/// 付箋の画像をエディタで開き直す / Re-open a pinned image in the editor
/// 注意: エディタウィンドウ表示を伴うためasync必須 / Must be async (shows the editor window)
#[tauri::command]
pub async fn edit_pin(app: AppHandle, id: u32) -> Result<(), String> {
    let png = app
        .state::<PinState>()
        .images
        .lock()
        .unwrap()
        .get(&id)
        .cloned()
        .ok_or("ピン画像が見つかりません")?;
    let image = xcap::image::load_from_memory(&png)
        .map_err(|e| e.to_string())?
        .to_rgba8();
    crate::editor::open_editor(&app, &image);
    Ok(())
}

/// 付箋が閉じられたら画像を破棄する / Drop the image when a pin is closed
pub fn forget(app: &AppHandle, label: &str) {
    if let Some(id) = label.strip_prefix("pin-").and_then(|s| s.parse::<u32>().ok()) {
        if let Some(state) = app.try_state::<PinState>() {
            state.images.lock().unwrap().remove(&id);
        }
    }
}
