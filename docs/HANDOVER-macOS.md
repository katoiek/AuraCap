# macOSビルド引き継ぎ / macOS Build Handover

> 対象コミット / Baseline: `main` (0.1.5)
> 目的 / Goal: 現在Windows専用のAuraCapを **macOSでビルド・起動できる状態**にする。
> まずは「無料版＝静止画キャプチャ＋エディタ」だけをmacOSで動かすのが最短ルート。録画・Smart Redactは後回しでよい。
> Start by getting the **free tier (still capture + editor)** compiling on macOS. Recording and Smart Redact can come later.

---

## 0. 現状サマリ / Current State

- スタック / Stack: **Tauri v2 + Rust backend + React 19 / TypeScript / Vite 7 / Tailwind 4**
- フロントエンド（`src/`）は **完全にクロスプラットフォーム**。macOS固有の対応は不要。
  The frontend is fully cross-platform; nothing macOS-specific is needed there.
- 問題は **Rustバックエンド（`src-tauri/src/`）が Win32 / WinRT API を無防備に直接呼んでいる** 点。
  `#[cfg(target_os = ...)]` ガードが一切ないため、**macOSでは現状コンパイルが通らない**。
  The Rust backend calls Win32/WinRT APIs with **no `cfg` guards**, so it will not compile on macOS as-is.

### Windows依存の内訳 / Where the Windows coupling lives

| ファイル / File | 依存API | 機能 / Feature | クロスプラットフォーム性 |
|---|---|---|---|
| `capture.rs` | Win32 (DWM, HWND列挙, `GetCursorPos`) | ウィンドウ単位キャプチャ・カーソル位置 | 静止画のコア取得は **`xcap`（クロスプラットフォーム）**。ウィンドウ列挙だけがWin32 |
| `recorder.rs` | `windows-capture` クレート (Windows Graphics Capture) | 画面録画（Pro機能） | **macOS非対応**。別実装が必要 |
| `redact.rs` | WinRT `Media.Ocr` | Smart Redact（OCRで機密自動検出） | **macOS非対応**。Vision.framework等で置換が必要 |

`bridge.rs` / `codegen.rs` / `editor.rs` / `history.rs` / `pin.rs` / `settings.rs` / `lib.rs` は **Win32非依存**（そのまま動くはず）。

> **コード生成（Screenshot-to-Code）はクロスプラットフォーム**。Ollama通信は `codegen.rs`（reqwest）経由に移行済みで、WebViewのCORS制約を受けない。Claude APIパスも `fetch` + `anthropic-dangerous-direct-browser-access` でOS非依存。macOSでもそのまま動く見込み。
> Code generation (Screenshot-to-Code) is cross-platform: Ollama traffic now goes through `codegen.rs` (reqwest), free of the WebView CORS constraint; the Claude path is OS-independent too.

---

## 1. 事前準備 / Prerequisites (macOS)

```sh
# Xcode Command Line Tools
xcode-select --install

# Rust（rustup推奨）
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Node.js 20+（Windows側と揃える）
# nvm等で

# 依存インストール
npm install
```

Tauri v2のmacOS前提は公式ドキュメント参照: https://v2.tauri.app/start/prerequisites/

---

## 2. 最短でビルドを通す手順（無料版スコープ） / Minimal path to a building free-tier

**方針**: 録画とOCRを **Windows限定**にフィーチャゲートし、macOSではそれらを無効化（もしくはstub）してビルドを通す。

### 2-1. `Cargo.toml` のWindows依存をターゲット限定にする

現在は無条件依存。以下のように **`[target.'cfg(windows)'.dependencies]`** へ移動する:

```toml
# 共通（クロスプラットフォーム） / cross-platform
[dependencies]
tauri = { version = "2", features = ["tray-icon", "image-png", "protocol-asset"] }
tauri-plugin-opener = "2"
tauri-plugin-global-shortcut = "2"
tauri-plugin-single-instance = "2"
tauri-plugin-autostart = "2"        # macOSはLaunchAgentで動作（対応済みプラグイン）
tauri-plugin-dialog = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
chrono = "0.4.45"
tiny_http = "0.12"
regex = "1"
reqwest = { version = "0.12", features = ["json"] }  # Ollama通信（macOS対応、CORS無関係）
xcap = "0.9.6"                       # ★静止画キャプチャのコア（macOS対応）
arboard = "3.6.1"                    # ★クリップボード（macOS対応）

# Windows専用 / Windows-only
[target.'cfg(windows)'.dependencies]
windows = { version = "0.62.2", features = [ /* 既存のfeature一式 */ ] }
windows-capture = "2.0.0"           # 録画
```

### 2-2. Rustコードを `#[cfg]` で分岐

- **`recorder.rs` 全体**を `#[cfg(windows)]` で囲む。`lib.rs` 側の `mod recorder;` と、録画系Tauriコマンドの登録（`invoke_handler`）も同様にガード。
  macOS向けにはコマンドだけ残して `Err("recording is Windows-only".into())` を返すstubを `#[cfg(not(windows))]` で用意すると、フロントの呼び出しが壊れない。
- **`redact.rs`** のOCR部分（`extract` / `OcrEngine` 周り）を同様に `#[cfg(windows)]` 化。macOSは `#[cfg(not(windows))]` で空文字/未対応エラーを返すstub。
- **`capture.rs`** のウィンドウ列挙（460行付近〜, `GetCursorPos` など）を `#[cfg(windows)]` に。
  - カーソル位置は Tauri の `window.cursor_position()` 等でクロスプラットフォーム化できる。
  - ウィンドウ単位キャプチャは `xcap::Window::all()`（xcapはウィンドウ列挙もサポート）へ寄せると理想。まずはmacOSで「領域＋全画面」だけ動けば無料版としては十分。

> ゴールの目安 / Definition of done for step 2:
> `npm run tauri dev` がmacOSで起動し、**領域キャプチャ→エディタ編集→保存/コピー** が一通り動く。

---

## 3. macOS固有の実行時ハマりどころ / macOS runtime gotchas

1. **画面収録の許可 (TCC)**: `xcap` でのスクリーンキャプチャは *システム設定 → プライバシーとセキュリティ → 画面収録* でアプリ許可が必要。初回は許可後に**再起動が要る**ことがある。
2. **グローバルショートカット**: 現在の既定は `PrintScreen` / `Ctrl+PrintScreen` / `Shift+PrintScreen`。**Macキーボードに PrintScreen は無い**。macOS向け既定を用意すること（例: `Cmd+Shift+2` 等、OS標準の `Cmd+Shift+3/4/5` と衝突しない組み合わせ）。`tauri-plugin-global-shortcut` 登録箇所（`lib.rs`）で `#[cfg(target_os="macos")]` 分岐。
   - グローバルショートカットには *アクセシビリティ* 許可が必要な場合あり。
3. **メニュー/トレイ**: macOSのトレイ（メニューバー）挙動はWindowsと異なる。アイコンはテンプレート画像（黒＋アルファ）が望ましい。動作確認を。
4. **アイコン**: `bundle.icon` に `icons/icon.icns` は既に含まれている。不足時は `npm run tauri icon <source-1024.png>` で再生成。
5. **署名・公証 / Signing & notarization**: 配布時はApple Developer証明書での署名とnotarizationが必要。ローカル動作確認だけなら不要。
6. **透明オーバーレイ窓**: 領域選択は透明窓＋SVGマスク方式（`Overlay.tsx`）。macOSでも透明窓は動くが、複数モニタの座標系・DPI（`devicePixelRatio`）挙動が異なるため、ルーペのピクセル対応（`LOUPE_*` 定数）と座標計算は実機で要確認。

---

## 4. 検証チェックリスト / Verification checklist

- [ ] `npm install` 成功
- [ ] `npm run tauri dev` でウィンドウ起動
- [ ] 画面収録許可を付与後、**領域キャプチャ**が撮れる
- [ ] エディタで 選択/矩形/矢印/テキスト/ハイライト/ぼかし/バッジ/トリミング が動く
- [ ] `Pictures/AuraCap/History` 相当（macOSは `~/Pictures/AuraCap/History`）へ自動保存＆クリップボードコピー
- [ ] 全画面（モニタ単位）キャプチャ
- [ ] コード生成：設定でOllama選択→ローカルモデルがドロップダウンに出る→生成が通る（`codegen.rs`経由）
- [ ] （後回し可）ウィンドウ単位キャプチャ
- [ ] （Pro / 後回し）録画・Smart Redact のstubがビルドを壊さない
- [ ] `npm run tauri build` で `.app` / `.dmg` が生成される

---

## 5. スコープ判断メモ / Scope notes

- **無料版 = 静止画キャプチャ＋エディタ**は `xcap` + `arboard` でmacOS移植コストが低い。まずここを完成させる。
- **録画（recorder.rs / windows-capture）** はmacOSでは `ScreenCaptureKit`（macOS 12.3+）ベースの別実装が必要。Rustからは `scap` クレート等が候補。Pro機能なので段階的に。
- **Smart Redact（redact.rs / WinRT OCR）** はmacOSでは `Vision.framework`（`VNRecognizeTextRequest`）で置換。これもPro寄り機能なので後回し。
- **コード生成** は移植作業不要（`codegen.rs` / `Editor.tsx` がクロスプラットフォーム）。無料版に含めてよい。

---

*最終更新 / Last updated: 2026-07-14（v0.1.5対応：Ollama通信のRust化・reqwest追加を反映） — 引き継ぎ作成: Claude (Opus 4.8)*
