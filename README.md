# AuraCap

Windows / macOS 向けの画面キャプチャツール。Tauri v2 + Rust製。撮ったものはすべて手元で完結し、外部サーバーへは何も送りません。
A screen capture tool for Windows and macOS, built with Tauri v2 + Rust. Everything stays on your machine — nothing is sent to any external server.

## 特徴 / Features

- **フリーズフレーム方式**: ホットキーを押した瞬間の画面を凍結し、その上で領域を選択（[ADR 0001](./docs/adr/0001-freeze-frame-instead-of-stealth-window.md)）
  **Freeze frame**: the screen is frozen the instant you press the hotkey; you select a region on the still image
- **3つのキャプチャモード**: 領域選択 / ウィンドウ単位 / 全画面（モニター単位）
  **3 capture modes**: region / window / full screen (per monitor)
- **軽量エディタ**: 矩形枠・矢印・テキスト・ハイライト・ぼかし・番号バッジ・トリミングを、出力するまで再編集できる
  **Quick editor**: rectangles, arrows, text, highlights, blur, numbered badges and crop — all re-editable until export
- **画面録画**: 全画面・領域をMP4で録画（Windows: Windows Graphics Capture / macOS: ScreenCaptureKit）
  **Screen recording**: full-screen or region capture to MP4 (Windows Graphics Capture / ScreenCaptureKit)
- **自動マスク（Smart Redact）**: メール・電話番号・カード番号・APIキー等をOCRで検出して自動でぼかす（Windowsのみ）
  **Smart Redact**: detects emails, phone numbers, card numbers and API keys via OCR and blurs them automatically (Windows only)
- **テキスト抽出**: 画像内の文字をOCRで読み取ってコピー（Windowsのみ）
  **Text extraction**: read on-image text with OCR and copy it (Windows only)
- **コード生成（Screenshot-to-Code）**: スクリーンショットからTailwind CSSのHTMLを生成。ローカルの [Ollama](https://ollama.com/) で処理
  **Screenshot-to-Code**: generate Tailwind CSS HTML from a screenshot, processed locally via [Ollama](https://ollama.com/)
- **全自動履歴保存**: 撮影した瞬間に `ピクチャ/AuraCap/History` へPNG保存＋クリップボードへコピー
  **Auto history**: every capture is saved to `Pictures/AuraCap/History` and copied to the clipboard
- **付箋（ピン留め）**: 編集後の画像を常に最前面のフローティング窓としてデスクトップに貼り付け
  **Pin to desktop**: keep an edited image on screen as an always-on-top floating window
- **フルページキャプチャ**: ブラウザ拡張（[extension/](./extension/)）でページ全体を一発取得（[ADR 0003](./docs/adr/0003-browser-extension-full-page-capture.md)）
  **Full-page capture**: grab an entire page in one shot via the browser extension
- **トレイ常駐**: メインウィンドウを閉じてもトレイに残り続ける
  **Tray resident**: keeps running in the tray when the main window is closed

## ショートカット / Shortcuts

| Windows | macOS | 動作 / Action |
|---|---|---|
| `PrintScreen` | `Cmd + Shift + 2` | 領域キャプチャ / Region capture |
| `Ctrl + PrintScreen` | `Cmd + Shift + 1` | ウィンドウキャプチャ / Window capture |
| `Shift + PrintScreen` | `Cmd + Shift + 6` | 全画面キャプチャ / Full screen capture |

ショートカットは設定画面から変更でき、まとめて無効にもできます。操作はすべてメインウィンドウのボタンからも行えます。
Shortcuts are configurable in settings and can be disabled entirely. Every action is also available from the buttons in the main window.

> Windows標準の「PrintScreenでSnipping Toolを開く」設定が有効な場合は、設定 > アクセシビリティ > キーボード からオフにしてください。
> If Windows' "Use PrintScreen to open Snipping Tool" is enabled, turn it off in Settings > Accessibility > Keyboard.

## プライバシー / Privacy

- キャプチャ画像・録画は `ピクチャ/AuraCap/History` にのみ保存されます。外部への送信は一切ありません。
- 自動マスクとテキスト抽出はOS標準のOCR（Windows）を使い、完全にローカルで動きます。
- コード生成は自分で立てたOllamaへのみ画像を送ります。送信先URLは設定画面で確認・変更できます。
- ブラウザ拡張との連携は `127.0.0.1:14820` のループバック限定で、拡張だけが付けられるヘッダを必須にしています。閲覧中のWebページから画像を投入することはできません。

- Captures and recordings are written only to `Pictures/AuraCap/History`; nothing is uploaded anywhere.
- Smart Redact and text extraction use the OS's built-in OCR (Windows) and run entirely locally.
- Screenshot-to-Code sends images only to the Ollama instance you run yourself; the target URL is visible and editable in settings.
- The browser-extension bridge is loopback-only (`127.0.0.1:14820`) and requires a header only the extension can set, so web pages you visit cannot push images into AuraCap.

## macOSで必要な権限 / Required macOS permissions

初回起動時に **画面収録（Screen Recording）** の許可を求められます。システム設定 > プライバシーとセキュリティ > 画面収録 で AuraCap を許可してください。動画録画は macOS 15 以降が必要です。
On first launch macOS asks for **Screen Recording** permission — allow AuraCap under System Settings > Privacy & Security > Screen Recording. Video recording requires macOS 15 or later.

## 開発 / Development

```sh
npm install
npm run tauri dev    # 開発起動 / run in dev mode
npm run tauri build  # 配布ビルド / production build
```

ドメイン用語は [CONTEXT.md](./CONTEXT.md)、設計判断は [docs/adr/](./docs/adr/)、配布時の署名は [docs/RELEASE.md](./docs/RELEASE.md) を参照。
See [CONTEXT.md](./CONTEXT.md) for domain language, [docs/adr/](./docs/adr/) for design decisions, and [docs/RELEASE.md](./docs/RELEASE.md) for signing and distribution.
