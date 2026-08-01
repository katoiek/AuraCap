# リリース手順と署名方針 / Release & code-signing

1.0 の配布に必要な手順と、コード署名の判断材料をまとめる。証明書の取得自体は別途対応が必要。

## 1. バージョンを揃える

以下4ファイルのバージョンは常に一致させる。ずれると更新チェックや診断ログが混乱する。

| ファイル | 項目 |
|---|---|
| `package.json` | `version` |
| `src-tauri/Cargo.toml` | `[package] version` |
| `src-tauri/tauri.conf.json` | `version` |
| `extension/manifest.json` | `version` |

## 2. ビルド前チェック

```sh
npm ci
npx tsc --noEmit                       # 型チェック / typecheck
npm audit --omit=dev                   # 配布物に入る依存の脆弱性 / vulns in shipped deps
cd src-tauri && cargo clippy --all-targets   # Rust lint
```

`npm audit` は開発依存（vite/esbuild）に警告が出ることがある。開発サーバーだけの問題で
配布物には含まれないため、`--omit=dev` の結果がクリーンなら配布して差し支えない。

## 3. 第三者ライセンス表示を更新する

AuraCap はプロプライエタリ配布なので、同梱するOSSの表示義務を自分で満たす必要がある。
依存を追加・更新したら必ず再生成する。

```sh
node scripts/gen_third_party_notices.mjs
```

生成される `THIRD-PARTY-NOTICES.md` は一覧（パッケージ名・バージョン・ライセンス識別子）まで。
**Apache-2.0 / BSD / ISC / MPL-2.0 / Unicode-3.0 / BSL-1.0 は全文の同梱が必要**なので、
一般公開する前にライセンス全文を `licenses/` に集めてインストーラーへ含めること（未対応）。

## 4. 配布ビルド

```sh
npm run tauri build
```

- Windows: `src-tauri/target/release/bundle/nsis/` に NSIS インストーラー（ユーザー/システム両モード）
- macOS: `src-tauri/target/release/bundle/dmg/` に DMG、`.../macos/` に .app

## 5. 動作確認（CSPが効いた状態での確認が必須）

1.0 で Content Security Policy を有効化した。カスタムプロトコル（`freeze:` / `loupe:` /
`edit:` / `pin:` / `asset:`）を明示的に許可しているが、許可漏れがあると**該当画面だけが
無言で壊れる**ため、リリースビルドで以下を必ず一通り触る。

- [ ] 領域キャプチャ（凍結フレームが見える＝`freeze:`）
- [ ] 領域選択中のルーペ表示（＝`loupe:`）
- [ ] エディタで画像が表示される（＝`edit:`）／コピー・保存
- [ ] 付箋（ピン留め）で画像が表示される（＝`pin:`）
- [ ] 履歴一覧のサムネイルと録画プレビュー（＝`asset:`）
- [ ] コード生成（Ollama 起動時）とテキスト抽出
- [ ] ブラウザ拡張からのフルページキャプチャ

DevTools のコンソールに `Refused to load ...` / `Refused to connect ...` が出ていないことも確認する。

## 6. コード署名

現状 **未署名**。未署名のまま配布した場合の挙動は以下。

### Windows

SmartScreen が「WindowsによってPCが保護されました」を表示し、「詳細情報」→「実行」の
2クリックを踏まないとインストールできない。ダウンロード数が増えるまで警告は消えない。

- **必要なもの**: OV または EV のコード署名証明書（EV は即座に SmartScreen の評価を得られるが高価）
- **設定**: `tauri.conf.json` の `bundle.windows.certificateThumbprint` に証明書のサムプリントを指定するか、
  環境変数 `TAURI_SIGNING_PRIVATE_KEY` 系ではなく Windows の署名は `signtool` 連携になる点に注意
- 2023年6月以降、コード署名証明書の秘密鍵は FIPS 140-2 準拠のハードウェアトークンか
  クラウドHSMでの保管が必須。CI で署名するならクラウド署名サービス（Azure Trusted Signing 等）が現実的

### macOS

Gatekeeper が「開発元を確認できないため開けません」で起動を拒否する。ユーザーは
右クリック→開く、またはシステム設定からの明示的な許可が必要。

- **必要なもの**: Apple Developer Program（年間 $99）の "Developer ID Application" 証明書
- **署名＋公証（notarization）の両方が必要**。署名だけでは Gatekeeper の警告は消えない
- **設定**: 環境変数 `APPLE_CERTIFICATE` / `APPLE_CERTIFICATE_PASSWORD` / `APPLE_SIGNING_IDENTITY` /
  `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` を渡して `npm run tauri build`
- `macOSPrivateApi: true`（オーバーレイの透明ウィンドウに必要）を使っているため
  **Mac App Store での配布はできない**。Developer ID による直接配布のみ

### 判断

| 選択肢 | コスト | 効果 |
|---|---|---|
| 未署名のまま配布 | 0 | 両OSで警告。導入の手順書が必須 |
| macOSのみ署名＋公証 | 約 $99/年 | macOS の警告が消える。Windows は警告のまま |
| 両OS署名 | $99/年＋証明書代（数万〜） | 警告なし |

配布先が限定的（社内・知人）なら未署名＋手順書で足りる。一般公開するなら
まず影響の大きい macOS の署名＋公証から着手するのが費用対効果が高い。

## 7. リリース

```sh
git tag v1.0.0 && git push origin v1.0.0
```

GitHub Releases にインストーラーを添付し、未署名の場合は上記の警告回避手順を本文に書く。
