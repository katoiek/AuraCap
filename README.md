# AuraCap

AI搭載を見据えたWindows向け画面キャプチャツール。Tauri v2 + Rust製。
An AI-ready screen capture tool for Windows, built with Tauri v2 + Rust.

## 特徴 / Features

- **フリーズフレーム方式**: ホットキーを押した瞬間の画面を凍結し、その上で領域を選択（[ADR 0001](./docs/adr/0001-freeze-frame-instead-of-stealth-window.md)）
  **Freeze frame**: the screen is frozen the instant you press the hotkey; you select a region on the still image
- **3つのキャプチャモード**: 領域選択 / ウィンドウ単位 / 全画面（モニター単位）
  **3 capture modes**: region / window / full screen (per monitor)
- **全自動履歴保存**: 撮影した瞬間に `ピクチャ/AuraCap/History` へPNG保存＋クリップボードへコピー
  **Auto history**: every capture is saved to `Pictures/AuraCap/History` and copied to the clipboard
- **トレイ常駐**: メインウィンドウを閉じてもトレイに残り続ける
  **Tray resident**: keeps running in the tray when the main window is closed

## ショートカット / Shortcuts

| キー / Keys | 動作 / Action |
|---|---|
| `PrintScreen` | 領域キャプチャ / Region capture |
| `Ctrl + PrintScreen` | ウィンドウキャプチャ / Window capture |
| `Shift + PrintScreen` | 全画面キャプチャ / Full screen capture |

> Windows標準の「PrintScreenでSnipping Toolを開く」設定が有効な場合は、設定 > アクセシビリティ > キーボード からオフにしてください。
> If Windows' "Use PrintScreen to open Snipping Tool" is enabled, turn it off in Settings > Accessibility > Keyboard.

## 開発 / Development

```sh
npm install
npm run tauri dev    # 開発起動 / run in dev mode
npm run tauri build  # 配布ビルド / production build
```

ドメイン用語は [CONTEXT.md](./CONTEXT.md)、設計判断は [docs/adr/](./docs/adr/) を参照。
See [CONTEXT.md](./CONTEXT.md) for domain language and [docs/adr/](./docs/adr/) for design decisions.
