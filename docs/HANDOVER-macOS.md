# macOS 引き継ぎ / macOS Handover

> **対象**: `main` = タグ `v1.0.4`（コミット `6d39945`）
> **目的**: 1.0.4 の macOS 版をビルドし、Windows 側で検証できなかった項目を実機で確認して、GitHub Release `v1.0.4` に追加する。
> **最終更新**: 2026-11-09 / 直前の作業環境: Windows 11
>
> Target: `main` = tag `v1.0.4` (commit `6d39945`). Goal: build the macOS app, verify on a real Mac what could not be checked on Windows, and attach the DMG to the `v1.0.4` GitHub Release.

---

## 最初に実行すること / Start here

**このドキュメントに書かれている機能はすべて `main` にコミット済み・push済みです。** 未コミットの作業はありません。

Mac 側のワーキングコピーが古いと「ドキュメントにある機能がコードに無い＝未コミット」と誤認しやすいので、作業前に必ず同期と確認を行ってください。

```sh
git checkout main && git pull origin main
git log --oneline -3          # 6d39945 が先頭にあること

# 録画カウントダウン機能（Esc中止・全画面対応込み）が入っているかの確認（すべて 1 以上が返れば OK）
grep -c reccountdown src-tauri/src/recorder.rs src-tauri/capabilities/default.json
grep -c 'countdown=1' src/App.tsx
grep -c cancel_countdown src-tauri/src/recorder.rs src-tauri/src/lib.rs
grep -c defaultShapeColor src/Home.tsx src/Editor.tsx
```

参考: 主要な機能がどのコミットで入ったかは `git log -S "<識別子>" --oneline` で特定できます。
例）`git log -S "run_countdown" --oneline` → `bce486e`

---

## 0. 現状サマリ

**macOS への移植は完了しています。** 0.1.5 時点のハンドオーバーにあった「Rust が Win32 を無防備に呼んでいてコンパイルが通らない」問題は解決済みで、macOS ビルドが成功することは確認されています（コミット `8fc4832`）。

| 項目 | 状態 |
|---|---|
| Windows 版 1.0.4 | リリース済み（タグ `v1.0.4`、NSIS インストーラーと MSI を添付済み） |
| macOS 版 1.0.4 | **未ビルド・未検証** ← このドキュメントの作業対象（macOS 版は 1.0.0 から一度も出していない） |
| リポジトリ公開範囲 | PRIVATE |
| コード署名 | Windows・macOS ともに **未署名** |

### プラットフォーム別の機能

| 機能 | Windows | macOS |
|---|---|---|
| 静止画キャプチャ（矩形 / ウィンドウ / 全画面） | ✅ | ✅ |
| 軽量エディタ・履歴・付箋 | ✅ | ✅ |
| 画面録画 | ✅ WGC | ✅ ScreenCaptureKit（**macOS 15+** が必要） |
| コード生成（Ollama） | ✅ | ✅ |
| テキスト抽出 | ✅ WinRT OCR | ❌ `ocr_stub.rs` が「未対応」を返す |

テキスト抽出の macOS 対応は `Vision.framework`（`VNRecognizeTextRequest`）での置換が必要ですが、1.0 のスコープ外です。

---

## 1. 直近のセッションで入った変更

タグ `v1.0.0` は以下の2コミットを含みます。macOS 側で確認すべき点が生じているのはこの変更群です。

### `bce486e` 1.0リリース準備

- **セキュリティ**: ブリッジの CSRF 対策、CSP 有効化、履歴コマンドのパス限定、ルーペの整数オーバーフロー修正
- **Claude API 連携を削除**: コード生成はローカル Ollama のみ。旧バージョンが平文保存していた API キーは起動時に `settings.json` から自動削除される
- **Editor.tsx を分割**: 1515行 → 1008行。`src/editor/{model.ts, raster.ts, Toolbar.tsx, ToolIcon.tsx, ResultModal.tsx}`
- **録画 UX**: 選択確定から録画開始まで枠を出したままにし、枠の中央にカウントダウンを表示

### `90a36d1` リリース整備

- アイコン・favicon、ライセンス本文の同梱、npm 依存の整理

### v1.0.1〜v1.0.4（`v1.0.0` 以降 / since v1.0.0）

`git log --oneline v1.0.0..v1.0.4` で全件を確認できます。macOS 側に影響があるもの:

| バージョン | 内容 | macOS での注意 |
|---|---|---|
| 1.0.1 | 自動マスク（Smart Redact）を廃止、AI コード生成に On/Off トグル | 特になし |
| 1.0.2 | 録画の動画形式に H.264/HEVC を選択可能に、WGC のモニターキャプチャへ切替 | **Windows の録画のみ**の変更。macOS は ScreenCaptureKit のまま（`video_codec` 設定は macOS では無視される） |
| 1.0.3 | 領域選択を凍結フレーム背景に変更（[ADR 0001](./adr/0001-freeze-frame-instead-of-stealth-window.md)） | 凍結フレームの表示が macOS でも崩れないか要確認（`freeze:` スキーム） |
| 1.0.4 | 下記 | 下記 §2-4 / §2-5 |

**1.0.4 の変更**

- エディタ: テキストのフォント選択（5種）、テキスト/バッジの個別サイズ変更（既定 70%）、ダブルクリックで再編集、詳細設定の開閉式化
- 設定: エディタの既定色（図形 / テキスト背景 / 文字）— `settings.json` に `defaultShapeColor` `defaultTextBgColor` `defaultTextColor` を追加
- 録画: 全画面でもカウントダウンを表示、カウントダウン中の Esc で中止、数字の位置補正
- 修正: 全画面録画でメイン窓が映る問題、全画面録画後のホットキー撮影が動画扱いになる問題

---

## 2. macOS で確認が必要な3点

Windows 側では検証済みですが、**macOS では未検証**です。設計上は動くはずという根拠と、駄目だった場合の直し方を添えます。

### 2-1. CSP（最重要）

1.0 で Content Security Policy を有効化しました（`src-tauri/tauri.conf.json` の `csp` / `devCsp`）。

カスタムプロトコルの URL 形式は OS で異なります。

- Windows: `http://freeze.localhost/...`
- macOS: `freeze://localhost/...`

CSP には **スキームのみの指定**（`freeze:` `loupe:` `edit:` `pin:` `asset:`）と Windows 形式の両方を書いてあります。スキームソースは仕様上どちらの形式にもマッチするため macOS でも通る想定ですが、実機で確認していません。

**許可漏れがあるとエラーダイアログは出ず、該当画面だけが無言で壊れます。** 特にルーペは `fetch` の失敗を握り潰しているため「拡大鏡が出ない」だけが症状になります。

**直し方**: DevTools（`Cmd+Option+I`）の Console に `Refused to load ... "img-src ..."` のようにブロックされた URL と違反したディレクティブが出ます。URL の形から追加先を決めます。

| ブロックされた URL | 追加先ディレクティブ |
|---|---|
| `freeze://...` `edit://...` `pin://...` | `img-src` |
| `loupe://...` | `connect-src` |
| `asset://...` | 画像なら `img-src`、動画なら `media-src` |

`csp` と `devCsp` の**両方**に追加してください。

### 2-2. カウントダウンの録画への写り込み

録画開始前のカウントダウンは選択範囲の**内側**に表示されます。`recorder.rs` の `run_countdown()` は、窓を隠してから `HIDE_SETTLE_MS = 200`（ミリ秒）待って録画を開始することで写り込みを防いでいます。

この 200ms は **Windows の DWM を前提に決めた値**です。macOS のコンポジタ（WindowServer）では足りない可能性があります。

**確認方法**: 矩形で動画キャプチャ → 生成された MP4 の冒頭を再生し、中央にカウントダウンのバッジが残っていないか見る。フレーム単位で確かめるなら:

```sh
ffmpeg -i ~/Pictures/AuraCap/History/auracap_YYYYMMDD_HHMMSS.mp4 -frames:v 6 /tmp/f_%02d.png
```

**直し方（2案）**:

1. **手軽**: `recorder.rs` の `HIDE_SETTLE_MS` を 400〜600 に増やす。待ち時間の合計は変わらない設計なので副作用はない
2. **確実（macOS のみ・推奨）**: `begin_recording()` の macOS 実装にある

   ```rust
   let filter = SCContentFilter::create()
       .with_display(&display)
       .with_excluding_windows(&[])   // ← ここ
       .build();
   ```

   に AuraCap 自身のウィンドウを渡す。ScreenCaptureKit のレベルで確実に除外できるため、タイミングに依存しなくなります。`SCShareableContent::get()` から得られる `windows()` を自プロセスの PID で絞り込んで渡します

### 2-3. カウントダウン窓の透過

新しく追加した `reccountdown` ウィンドウは `.transparent(true)` を使います。macOS では `macOSPrivateApi: true` が必要ですが、`tauri.conf.json` に設定済みであることは確認済みです。

`skip_taskbar` は macOS では無効ですが、既存の録画枠バー窓も同じ指定なので新たな問題ではありません。

### 2-4. 全画面カウントダウンと Esc 中止（1.0.4 / macOS 未検証）

Fullscreen countdown and Esc-to-cancel (new in 1.0.4, unverified on macOS).

- **位置**: 全画面ではプライマリモニターの中央に出します（`recorder.rs` の `primary_monitor_rect()`）。Tauri の `primary_monitor()` は物理 px で返すため、Retina で位置・大きさがずれていないか確認してください。ずれる場合は `show_countdown()` に渡す矩形のスケール変換（macOS はポイント単位）を疑う
- **Esc**: カウントダウン中だけ `Escape` をグローバルショートカットとして登録します（窓はクリック透過・非フォーカスでキーが届かないため）。macOS で素の `Escape` が登録できるか、押して止まるかを確認する。登録に失敗するとログに `could not register Esc for countdown cancel` が出る
- **メイン窓**: 全画面録画ではカウントダウン前にメイン窓を隠し、開始後または中止時に戻します。録画の冒頭にメイン窓が写っていないことを確認する
- **数字の位置補正**: `App.tsx` の `inkOffset()` は `canvas.measureText` の `fontBoundingBoxAscent` を使います。macOS（WebKit）で円の中心に収まって見えるか確認する。フォントは `Segoe UI` が無いため `system-ui` にフォールバックします

### 2-5. フォントのフォールバックと書き出し（1.0.4 / macOS 未検証）

エディタのフォント選択は、各プリセットに Windows と macOS の両方のフォント名を並べています（`src/editor/model.ts` の `TEXT_FONTS`）。

| プリセット | macOS で使われる想定 | 注意 |
|---|---|---|
| ゴシック | Hiragino Sans | |
| UDゴシック | Hiragino Maru Gothic ProN | Windows の `BIZ UDPGothic` とは字形が違う（丸ゴシック） |
| 明朝 | Hiragino Mincho ProN | |
| 教科書体 | Hiragino Maru Gothic ProN | `UD Digi Kyokasho` は Mac に無く、**教科書体にはならない**（丸ゴシックで代用） |
| 等幅 | Menlo | 日本語部分は `Yu Gothic UI` が無く別フォントになる |

確認点: 各フォントで**画面上の見た目と書き出した画像が一致する**こと（`measureText` の実測値で吹き出しの余白を決めているため、フォントが変わっても枠からはみ出さないはず）。教科書体の代用が許容できないなら、プリセットのラベルを OS ごとに出し分けるか、Mac では非表示にする。

---

## 3. ビルド手順

```sh
git pull origin main          # または git checkout v1.0.4
npm ci
npx tsc --noEmit
npm audit --omit=dev          # 0件になるはず
cd src-tauri && cargo clippy --all-targets && cd ..
npm run tauri build
```

出力先:
- `src-tauri/target/release/bundle/dmg/` — DMG
- `src-tauri/target/release/bundle/macos/` — .app

### ⚠️ THIRD-PARTY-LICENSES.txt を macOS で再生成しないこと

`scripts/gen_third_party_notices.mjs` は、ローカルの cargo レジストリと `node_modules` から**実ファイル**を読んでライセンス本文を集めます。macOS のレジストリには Windows 専用クレート（`windows`, `windows-capture` 等）のソースが落ちていないため、macOS で再生成すると**収録内容が減ります**。

現在コミットされているものは Windows 側で生成した全プラットフォーム分です。依存を変更していない限り、そのまま使ってください。

---

## 4. 検証チェックリスト

DevTools は各ウィンドウで `Cmd+Option+I`。ウィンドウごとに別インスタンスです。

### 事前

- [ ] 初回起動時、右クリック → 開く で Gatekeeper を通す（未署名のため）
- [ ] システム設定 → プライバシーとセキュリティ → 画面収録 で AuraCap を許可
  （バイナリが変わると再度求められることがある）

### CSP 関連（2-1 の検証）

- [ ] 領域キャプチャで凍結フレームが見える（`freeze:`）
- [ ] 選択中にルーペ（拡大鏡）が表示される（`loupe:` / connect-src）
- [ ] エディタに画像が表示される（`edit:`）
- [ ] エディタの「コピー」「保存」が成功する（canvas の CORS 汚染がないこと）
- [ ] 付箋（ピン留め）に画像が表示される（`pin:`）
- [ ] 履歴一覧のサムネイルが並ぶ（`asset:` / img-src）
- [ ] 履歴の録画プレビューが再生できる（`asset:` / media-src）
- [ ] Console に `Refused to` が1件も出ていない

### 録画（2-2 の検証）

- [ ] 矩形で動画キャプチャ → 選択確定した瞬間から枠が出たままになる
- [ ] 枠の中央に 3 → 2 → 1 のカウントダウンが出る
- [ ] **録画された MP4 の冒頭に数字が写り込んでいない**
- [ ] ウィンドウモードでも同様
- [ ] 全画面録画でプライマリモニター中央にカウントダウンが出る（§2-4）
- [ ] カウントダウン中に Esc を押すと録画されずメイン窓が戻る（全画面・矩形の両方。矩形は枠も消える）
- [ ] 全画面録画の冒頭にメイン窓・カウントダウンの数字が写っていない

### その他

- [ ] ホットキー（`Cmd+Shift+2` / `Cmd+Shift+1` / `Cmd+Shift+6`）が効く
      ※アクセシビリティ許可が必要な場合あり
- [ ] `~/Pictures/AuraCap/History` へ自動保存＋クリップボードコピー
- [ ] エディタの全ツール（矩形 / 矢印 / テキスト / ハイライト / ぼかし / バッジ / トリミング）
- [ ] テキストのフォント選択・サイズ変更・ダブルクリック再編集、バッジのサイズ変更（§2-5）
- [ ] 設定画面の「エディタの既定色」を変えて次のキャプチャから反映される
- [ ] コード生成（Ollama 起動時）
- [ ] テキスト抽出が「未対応」のトーストを返し、クラッシュしない
- [ ] トレイ（メニューバー）アイコンとメニューが機能する

### ブラウザ拡張

- [ ] `chrome://extensions` → デベロッパーモード → `extension/` を読み込む
- [ ] 通常の https ページでツールバーボタン → 緑の OK バッジ、エディタにページ全体が入る

拡張は `X-AuraCap-Bridge` ヘッダを送ります。ブリッジ側（`bridge.rs`）はこのヘッダを必須とし、Web ページ由来（http/https）の Origin を拒否します。拡張の Origin（`chrome-extension://`）は通ります。

判定ロジックだけ確かめるなら:

```sh
# 403 を期待（ヘッダ無し）
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:14820/capture --data "x"
# 400 を期待（受理され、画像として不正なので400）
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:14820/capture -H "X-AuraCap-Bridge: 1" --data "x"
```

---

## 5. リリースへの追加

検証が通ったら既存のリリースに DMG を追加します。

```sh
gh release upload v1.0.4 src-tauri/target/release/bundle/dmg/AuraCap_1.0.4_aarch64.dmg
```

ファイル名は実際の出力に合わせてください（Apple Silicon = `aarch64`、Intel = `x64`）。

**リリースノートの修正も必要です。** 現在「このリリースは Windows 版のみです」と書かれているため、macOS バイナリを追加したらその記述を更新してください（SHA256 の節を設けている場合はそちらも）。

```sh
shasum -a 256 src-tauri/target/release/bundle/dmg/*.dmg
gh release edit v1.0.4 --notes-file <更新したノート>
```

---

## 6. 落とし穴（実際に踏んだもの）

### capabilities に窓を登録し忘れる

`src-tauri/capabilities/default.json` の `windows` 配列に載っていないウィンドウでは、`invoke()` も `listen()` も**エラーを出さずに拒否**されます。カウントダウン機能の実装時、これで「円は描画されるが数字が出ない」という状態になり、原因特定に時間を要しました。

新しいウィンドウを追加して Tauri API を呼ぶ場合は、必ずこのリストに追加してください。描画しかしないウィンドウ（`recframe-*`）は最小権限のため意図的に除外しています。

### Chrome 拡張の fetch には Origin が付く

MV3 の Service Worker からの `fetch()` には、ブラウザが `Origin: chrome-extension://<id>` を自動付与します。「Origin があれば拒否」という実装にすると正規の拡張まで弾かれます（`bridge.rs` は http/https の Origin のみ拒否する実装になっています）。

### 開発モードでは本番 CSP を検証できない

Tauri は開発時に `devCsp`、本番ビルドで `csp` を適用します。本番 CSP を DevTools 付きで確認するには:

```sh
npm run tauri build -- --debug
```

CSP は `<meta>` タグではなく **HTTP レスポンスヘッダ**で配信されます。DevTools の Network タブ → ドキュメントのリクエスト → Response Headers で確認できます。

---

## 7. バージョン管理

バージョンは以下4ファイルで一致させます。ずれると診断が混乱します。

| ファイル | 項目 |
|---|---|
| `package.json` | `version` |
| `src-tauri/Cargo.toml` | `[package] version` |
| `src-tauri/tauri.conf.json` | `version` |
| `extension/manifest.json` | `version` |

リリース手順の全体は [RELEASE.md](./RELEASE.md)、ドメイン用語は [../CONTEXT.md](../CONTEXT.md)、設計判断は [adr/](./adr/) を参照してください。

---

## 8. 既知の制約

- **Mac App Store で配布できません。** オーバーレイの透明ウィンドウに `macOSPrivateApi: true` が必要なためです。Developer ID による直接配布のみ
- **署名・公証が未対応。** Gatekeeper の警告を消すには Apple Developer Program（年 $99）の "Developer ID Application" 証明書での署名＋公証の両方が必要です。詳細と費用比較は [RELEASE.md](./RELEASE.md) の「コード署名」節
- **動画録画は macOS 15 以降が必要。** `SCRecordingOutput`（`screencapturekit` の `macos_15_0` feature）に依存しています
- **全画面録画のカウントダウン位置は macOS 未検証。** 1.0.4 で実装済み（プライマリモニター中央）。DPI 変換（macOS はポイント単位）の扱いを実機で確認すること（§2-4）
- **テキスト抽出は Windows 専用**（WinRT OCR 依存）
