# ADR 0003: フルページキャプチャはブラウザ拡張＋ローカルブリッジで実現する

## ステータス

採用 (2026-06-11)

## コンテキスト

スクロールが必要な長いコンテンツ全体のキャプチャ（スクロールキャプチャ）を実装したい。
利用シーンを検討した結果、対象はブラウザのWebページに限定してよいと判断した。

検討した選択肢：

1. **汎用スクロール合成（Snagit方式）**: 任意のウィンドウへスクロールを注入し、
   逐次撮影した画像をテンプレートマッチングで縫い合わせる。
   どんなアプリでも使えるが、固定ヘッダー・遅延読み込み・仮想化リスト等で
   合成が乱れやすく、実装の大半が合成品質のチューニングになる。
2. **CDP直接続**: AuraCapがChrome DevTools Protocolでブラウザに接続し、
   `Page.captureScreenshot`（captureBeyondViewport）で一発取得する。
   画質は完璧だが、ブラウザを `--remote-debugging-port` 付きで起動して
   おく必要があり、普段使いのブラウザに使えない。
3. **ブラウザ拡張＋ローカルブリッジ**: 拡張機能が `chrome.debugger` APIで
   タブにアタッチし、CDPと同じコマンドでフルページを取得して、
   AuraCap本体のローカルHTTPブリッジ（127.0.0.1:14820）へPOSTする。

## 決定

選択肢3（ブラウザ拡張＋ローカルブリッジ）を採用する。

- `chrome.debugger` APIはDevToolsの「Capture full size screenshot」と同じ
  コマンドを起動フラグなしで実行できる。**選択肢2の画質（合成なし一発取得）を
  普段使いのブラウザで実現できる**、2と3のいいとこ取りになる。
- ブラウザ差分（Chromium系/Firefox）は拡張側に閉じ込められ、本体は
  「PNGを受け取って既存のfinalize()へ流すだけ」に保てる。
- Chromium系（Chrome/Edge/Brave等）はすべて同一の拡張で動く。
  Firefoxは将来 `tabs.captureTab` ベースの姉妹拡張で同じブリッジに対応できる。

## 帰結

- ブラウザ以外（PDFビューア・業務アプリ等）のスクロールキャプチャはできない。
  必要になったら選択肢1を同じUIの裏に追加する（ブリッジ/エディタ側は手戻りなし）。
- 拡張はストア配布せず、リポジトリの `extension/` をデベロッパーモードで
  読み込んで使う（個人用ツールのため）。
- ブリッジはループバック限定・受信上限64MB。認証トークンは現状なし
  （ローカルプロセスからの誤送信リスクのみ）。製品化時に再検討する。
- キャプチャ時にChromiumが「デバッグ中」の情報バーを表示する仕様は許容する。

---

# ADR 0003: Full-page capture via a browser extension + local bridge

## Status

Accepted (2026-06-11)

## Context

We want to capture long, scrollable content. Usage analysis showed limiting the
target to browser web pages is acceptable. Options considered: (1) generic
scroll-and-stitch (inject scroll, stitch frames; works everywhere but fragile
with sticky headers / lazy loading / virtualized lists), (2) direct CDP
connection (perfect quality but requires launching the browser with
`--remote-debugging-port`), (3) a browser extension using the `chrome.debugger`
API that POSTs the PNG to AuraCap's local HTTP bridge (127.0.0.1:14820).

## Decision

Option 3. The `chrome.debugger` API runs the same command as DevTools'
"Capture full size screenshot" without launch flags — option 2's quality in the
user's everyday browser. Browser differences stay inside the extension; the app
core just feeds received PNGs into the existing finalize() pipeline. One
extension covers all Chromium browsers; Firefox can join later via
`tabs.captureTab` against the same bridge.

## Consequences

Non-browser scrolling capture is out of scope (option 1 can be added behind the
same UI later). The extension is loaded unpacked from `extension/` (no store
distribution). The bridge is loopback-only with a 64MB cap and no auth token
for now (revisit before productizing). Chromium's "being debugged" infobar
during capture is accepted.
