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

/// 拡張だけが付けられる識別ヘッダ。これを必須にすることで、閲覧中のWebページから
/// このエンドポイントを叩かれるのを防ぐ（カスタムヘッダはCORSプリフライトを強制し、
/// サーバーはOPTIONSに応答しないためブラウザ側でブロックされる）。
/// 拡張は host_permissions によりCORSの対象外なので、そのまま付与できる。
/// Header only the extension can set. Requiring it blocks CSRF from any web page the
/// user is browsing: a custom header forces a CORS preflight, and we never answer
/// OPTIONS, so the browser blocks the request. The extension holds host_permissions
/// and is exempt from CORS, so it can set the header directly.
const BRIDGE_HEADER: &str = "x-auracap-bridge";

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
            let headers = request.headers();
            // 識別ヘッダは必須。これが本体の防御で、Webページはプリフライトを通せず付けられない。
            // The identifying header is the actual defense: a web page can't set it (preflight fails).
            let has_marker = headers
                .iter()
                .any(|h| h.field.equiv(BRIDGE_HEADER) && !h.value.as_str().is_empty());
            // 二重の防御としてOriginも見る。ただし拡張のfetchにはブラウザが
            // Origin: chrome-extension://<id> を自動付与するため、「Originがあれば拒否」では
            // 正規の拡張まで弾いてしまう。拒否するのはWebページ由来（http/https）のOriginのみ。
            // Origin is a second layer, but the browser attaches Origin: chrome-extension://<id> to
            // the extension's own fetch, so "reject any Origin" would block the real extension.
            // Only web-page origins (http/https) are rejected.
            let origin_ok = headers
                .iter()
                .find(|h| h.field.equiv("origin"))
                .map(|h| {
                    let v = h.value.as_str();
                    v.starts_with("chrome-extension://") || v.starts_with("moz-extension://")
                })
                // Originなし＝ローカルのCLI等。ヘッダ必須で守る / No Origin = a local CLI; the header guards it
                .unwrap_or(true);
            if !has_marker || !origin_ok {
                // どちらで落ちたか分かるようにする（拡張の更新漏れの切り分け用）
                // Log which check failed, so a stale extension is easy to tell apart
                let reason = if !has_marker { "missing header" } else { "web origin" };
                eprintln!("[auracap] bridge: rejected request ({reason})");
                let _ = request.respond(Response::empty(403));
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
