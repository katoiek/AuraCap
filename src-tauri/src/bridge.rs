// ブラウザ拡張連携用のローカルHTTPブリッジ
// 拡張がフルページキャプチャしたPNGをPOSTで受け取り、通常のキャプチャと同じ
// 後処理（履歴保存→クリップボード→エディタ起動）へ流す。
// Local HTTP bridge for the browser extension: receives full-page capture PNGs
// via POST and routes them through the normal pipeline (history → clipboard → editor).

use std::io::Read;

use tauri::AppHandle;
use tiny_http::{Method, Response, Server};

/// 待受アドレス。ループバック限定なので外部からは到達できない
/// Bind address; loopback-only, unreachable from outside the machine
const BRIDGE_ADDR: &str = "127.0.0.1:14820";

/// 受信ボディの上限（64MB）。巨大ページの暴走や誤送信からの保護
/// Body size cap (64MB) against runaway pages and accidental posts
const MAX_BODY_BYTES: usize = 64 * 1024 * 1024;

pub fn start(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let server = match Server::http(BRIDGE_ADDR) {
            Ok(s) => s,
            Err(e) => {
                // 多重起動時など。本体機能は生きるのでエラーログのみ
                // E.g. another instance holds the port; core features still work
                eprintln!("[auracap] bridge: failed to bind {BRIDGE_ADDR}: {e}");
                return;
            }
        };
        eprintln!("[auracap] bridge listening on {BRIDGE_ADDR}");

        for mut request in server.incoming_requests() {
            if request.method() != &Method::Post || request.url() != "/capture" {
                let _ = request.respond(Response::empty(404));
                continue;
            }
            if request
                .body_length()
                .is_some_and(|len| len > MAX_BODY_BYTES)
            {
                let _ = request.respond(Response::empty(413));
                continue;
            }
            let mut body = Vec::new();
            if request
                .as_reader()
                .take(MAX_BODY_BYTES as u64 + 1)
                .read_to_end(&mut body)
                .is_err()
                || body.len() > MAX_BODY_BYTES
            {
                let _ = request.respond(Response::empty(400));
                continue;
            }

            match xcap::image::load_from_memory(&body) {
                Ok(img) => {
                    eprintln!(
                        "[auracap] bridge: received full-page capture ({} bytes)",
                        body.len()
                    );
                    let image = img.to_rgba8();
                    let app = app.clone();
                    // finalizeは重い処理（PNG保存等）を含むため受信ループから切り離す
                    // finalize is heavy (PNG encode etc.), keep the accept loop responsive
                    std::thread::spawn(move || {
                        if let Err(e) = crate::capture::finalize(&app, image) {
                            eprintln!("[auracap] bridge finalize failed: {e}");
                        }
                    });
                    let _ = request.respond(Response::from_string("ok"));
                }
                Err(e) => {
                    eprintln!("[auracap] bridge: invalid image payload: {e}");
                    let _ = request.respond(Response::empty(400));
                }
            }
        }
    });
}
