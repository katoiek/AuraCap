// AuraCap フルページキャプチャ拡張
// ツールバーボタン押下で、開いているタブにdebugger APIでアタッチし、
// DevToolsの「Capture full size screenshot」と同じコマンドでページ全体を取得して
// AuraCap本体のローカルブリッジ（127.0.0.1:14820）へPOSTする。
// AuraCap full-page capture extension: on toolbar click, attach the debugger API
// to the active tab, run the same command as DevTools' "Capture full size
// screenshot", and POST the PNG to AuraCap's local bridge (127.0.0.1:14820).

const BRIDGE_URL = "http://127.0.0.1:14820/capture";

// Chromiumのテクスチャ上限。これを超える縦長ページは上から切り詰めて取得する
// Chromium's texture cap; taller pages are clipped from the top
const MAX_DIMENSION = 16384;

// バッジで結果を短時間フィードバックする / Brief feedback via the action badge
function flashBadge(text, color) {
  chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setBadgeText({ text });
  setTimeout(() => chrome.action.setBadgeText({ text: "" }), 2500);
}

// 遅延読み込みコンテンツの再描画待ち時間 / Wait for lazy-loaded content to render
const RELAYOUT_WAIT_MS = 600;

async function captureFullPage(tab) {
  const target = { tabId: tab.id };
  await chrome.debugger.attach(target, "1.3");
  const send = (method, params) => chrome.debugger.sendCommand(target, method, params);
  try {
    const metrics = await send("Page.getLayoutMetrics");
    const size = metrics.cssContentSize ?? metrics.contentSize;
    const width = Math.min(Math.ceil(size.width), MAX_DIMENSION);
    const height = Math.min(Math.ceil(size.height), MAX_DIMENSION);

    // ビューポート自体をページ全高へ拡げてから等倍で撮る。
    // captureBeyondViewportは固定ヘッダー・遅延描画ページで最初の画面が
    // 繰り返される既知の不具合があるため使わない。
    // Resize the viewport itself to the full page height, then capture 1:1.
    // captureBeyondViewport is avoided: it has a known bug where the first
    // viewport repeats on pages with fixed headers / lazy rendering.
    await send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await new Promise((r) => setTimeout(r, RELAYOUT_WAIT_MS));

    const shot = await send("Page.captureScreenshot", { format: "png" });
    return shot.data; // base64 PNG
  } finally {
    try {
      await send("Emulation.clearDeviceMetricsOverride");
    } catch {
      // detachでも解除されるため失敗は無視 / Detach clears overrides anyway
    }
    await chrome.debugger.detach(target).catch(() => {});
  }
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;
  try {
    const base64 = await captureFullPage(tab);
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const res = await fetch(BRIDGE_URL, {
      method: "POST",
      // X-AuraCap-Bridge はブリッジ側の必須ヘッダ。Webページはプリフライトを通せないため
      // 付けられず、これがCSRF（閲覧中のサイトからの画像注入）の防波堤になる。
      // X-AuraCap-Bridge is required by the bridge. Web pages can't set it (their preflight
      // fails), which is what blocks CSRF image injection from sites the user is browsing.
      headers: { "Content-Type": "image/png", "X-AuraCap-Bridge": "1" },
      body: bytes,
    });
    if (!res.ok) throw new Error(`bridge responded ${res.status}`);
    flashBadge("OK", "#22c55e");
  } catch (e) {
    console.error("[auracap-ext] capture failed:", e);
    // AuraCap未起動・chrome://等の保護ページ・デバッガ競合などでここに来る
    // Lands here when AuraCap is not running, on protected pages, or debugger conflicts
    flashBadge("ERR", "#ef4444");
  }
});
