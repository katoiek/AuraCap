// 配布物に含まれる第三者ソフトウェアの表示（THIRD-PARTY-NOTICES.md / THIRD-PARTY-LICENSES.txt）を生成する。
// AuraCapはプロプライエタリ配布なので、同梱するOSSの表示義務を自分で満たす必要がある。
//   - THIRD-PARTY-NOTICES.md  : 一覧（パッケージ名・バージョン・ライセンス識別子）
//   - THIRD-PARTY-LICENSES.txt: 各コンポーネントのライセンス本文（Apache-2.0等は全文同梱が必須）
// Rust側は `cargo metadata`、npm側は package.json の dependencies から実際にバンドルへ入るものだけを
// 辿る（devDependenciesは配布物に含まれないため除外）。本文はローカルのレジストリ／node_modules から
// 実ファイルを読むので、上流が配っているものそのままになる。
//
// Generates the third-party disclosures shipped with AuraCap, which is distributed under a
// proprietary license and therefore must carry the bundled OSS notices itself:
//   - THIRD-PARTY-NOTICES.md   : inventory (name, version, license id)
//   - THIRD-PARTY-LICENSES.txt : the license texts themselves (Apache-2.0 and friends require them)
// Rust comes from `cargo metadata`; npm walks package.json dependencies only (devDependencies never
// reach the bundle). Texts are read from the local registry / node_modules, so they are verbatim
// copies of what upstream ships.
//
// 使い方 / Usage: node scripts/gen_third_party_notices.mjs

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---- Rust ----

function rustPackages() {
  const raw = execFileSync(
    "cargo",
    ["metadata", "--format-version", "1", "--all-features"],
    { cwd: path.join(root, "src-tauri"), encoding: "utf8", maxBuffer: 128 * 1024 * 1024 },
  );
  const meta = JSON.parse(raw);
  return meta.packages
    .filter((p) => p.name !== "auracap")
    .map((p) => ({
      name: p.name,
      version: p.version,
      license: p.license ?? "(unspecified)",
      dir: path.dirname(p.manifest_path),
    }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

// ---- npm ----

function readPkg(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

/// node_modulesはフラットに置かれるので名前解決はトップレベルで足りる。ネストされている場合のみ潜る。
/// node_modules is flat, so top-level lookup suffices; fall back into a nested copy when present.
function resolvePkgDir(name, fromDir) {
  const nested = path.join(fromDir, "node_modules", name);
  if (fs.existsSync(path.join(nested, "package.json"))) return nested;
  const top = path.join(root, "node_modules", name);
  return fs.existsSync(path.join(top, "package.json")) ? top : null;
}

function npmPackages() {
  const found = new Map();
  const rootPkg = readPkg(root);
  const queue = Object.keys(rootPkg?.dependencies ?? {}).map((n) => [n, root]);
  while (queue.length) {
    const [name, from] = queue.shift();
    const dir = resolvePkgDir(name, from);
    if (!dir) continue;
    const pkg = readPkg(dir);
    if (!pkg?.version) continue;
    const key = `${pkg.name}@${pkg.version}`;
    if (found.has(key)) continue;
    const license =
      pkg.license ?? (pkg.licenses ? pkg.licenses.map((l) => l.type ?? l).join(" OR ") : "(unspecified)");
    found.set(key, { name: pkg.name, version: pkg.version, license, dir });
    for (const dep of Object.keys(pkg.dependencies ?? {})) queue.push([dep, dir]);
  }
  return [...found.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
  );
}

// ---- ライセンス本文の収集 / Collecting license texts ----

/// パッケージのディレクトリ直下からライセンス/著作権表示ファイルを拾う
/// Pick up license and notice files sitting at the root of a package directory
function licenseFilesIn(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && /^(LICEN[SC]E|COPYING|NOTICE|UNLICENSE)/i.test(e.name))
    .map((e) => {
      try {
        return { file: e.name, text: fs.readFileSync(path.join(dir, e.name), "utf8") };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/// 同一本文はまとめる。MITのように著作権者名だけが違うものは別扱いのまま残る
/// （名前が違えば本文も違うため）。完全一致だけを畳むので表示義務は満たしたまま短くなる。
/// Fold byte-identical texts together. MIT variants that differ only by copyright holder stay
/// separate (different holder = different text), so nothing required is dropped.
function collectTexts(pkgs, ecosystem) {
  const byHash = new Map();
  const missing = [];
  for (const p of pkgs) {
    const files = licenseFilesIn(p.dir);
    if (files.length === 0) {
      missing.push(p);
      continue;
    }
    for (const f of files) {
      const hash = crypto.createHash("sha256").update(f.text).digest("hex");
      if (!byHash.has(hash)) byHash.set(hash, { text: f.text, file: f.file, users: [] });
      byHash.get(hash).users.push(`${ecosystem}: ${p.name} ${p.version}`);
    }
  }
  return { byHash, missing };
}

// ---- 出力 / Output ----

function summarize(pkgs) {
  const by = new Map();
  for (const p of pkgs) by.set(p.license, (by.get(p.license) ?? 0) + 1);
  return [...by.entries()].sort((a, b) => b[1] - a[1]);
}

function table(pkgs) {
  return pkgs.map((p) => `| ${p.name} | ${p.version} | ${p.license} |`).join("\n");
}

const rust = rustPackages();
const npm = npmPackages();
const generated = new Date().toISOString().slice(0, 10);

const notices = `# THIRD-PARTY NOTICES

AuraCap には以下のオープンソースコンポーネントが含まれます。各コンポーネントは
それぞれの提供者が定めるライセンス条件のもとで利用しており、当該部分については
本ソフトウェアの [LICENSE](./LICENSE) ではなく各ライセンスが適用されます。
ライセンス本文は [THIRD-PARTY-LICENSES.txt](./THIRD-PARTY-LICENSES.txt) に全文を収録しています。

AuraCap includes the open-source components listed below. Each is used under the terms set by
its own authors; for those components their license governs, not AuraCap's [LICENSE](./LICENSE).
The full license texts are collected in [THIRD-PARTY-LICENSES.txt](./THIRD-PARTY-LICENSES.txt).

このファイルは \`node scripts/gen_third_party_notices.mjs\` で生成しています。
依存を追加・更新したら再生成してください。
Generated by \`node scripts/gen_third_party_notices.mjs\`; regenerate whenever dependencies change.

生成日時 / Generated: ${generated}

## 注意が必要なライセンス / Licenses needing attention

- **MPL-2.0**: ファイル単位のコピーレフト。同梱しているものは未改変のため、
  ソース入手先（crates.io / npm）を示せば足ります。改変した場合は当該ファイルの
  ソース公開が必要です。
  File-level copyleft. The bundled copies are unmodified, so pointing at the upstream source
  is sufficient; modifying them would require publishing those files.
- **Apache-2.0**: ライセンス全文と NOTICE ファイルの同梱が必要です。
  Requires shipping the full license text and any NOTICE file.
- **Unicode-3.0 / BSD / ISC / BSL-1.0 / CC-BY-4.0**: 著作権表示とライセンス条文の
  表示が必要です。
  Require reproducing the copyright notice and license terms.

## Rust クレート / Rust crates (${rust.length})

ライセンス別の内訳 / Breakdown by license:

${summarize(rust).map(([l, n]) => `- ${l}: ${n}`).join("\n")}

| Package | Version | License |
|---|---|---|
${table(rust)}

## npm パッケージ / npm packages (${npm.length})

配布物に含まれる依存のみ（devDependenciesは対象外）。
Only dependencies that reach the bundle; devDependencies are excluded.

ライセンス別の内訳 / Breakdown by license:

${summarize(npm).map(([l, n]) => `- ${l}: ${n}`).join("\n")}

| Package | Version | License |
|---|---|---|
${table(npm)}
`;

fs.writeFileSync(path.join(root, "THIRD-PARTY-NOTICES.md"), notices);

const rustTexts = collectTexts(rust, "crate");
const npmTexts = collectTexts(npm, "npm");
const missing = [...rustTexts.missing, ...npmTexts.missing];

const blocks = [...rustTexts.byHash.values(), ...npmTexts.byHash.values()];
const sep = "=".repeat(78);
const body = blocks
  .map((b) => {
    const users = b.users.map((u) => `  ${u}`).join("\n");
    return `${sep}\n${b.file}\n\n該当コンポーネント / Applies to:\n${users}\n${"-".repeat(78)}\n\n${b.text.trimEnd()}\n`;
  })
  .join("\n");

const licenses = `AuraCap - THIRD-PARTY LICENSE TEXTS
Generated: ${generated} (node scripts/gen_third_party_notices.mjs)

このファイルは AuraCap に同梱されるオープンソースコンポーネントのライセンス本文を
そのまま収録したものです。コンポーネントの一覧は THIRD-PARTY-NOTICES.md を参照してください。
本文が完全に一致するものはまとめて1回だけ掲載し、該当コンポーネントを列挙しています。

This file reproduces, verbatim, the license texts of the open-source components bundled with
AuraCap. See THIRD-PARTY-NOTICES.md for the component inventory. Byte-identical texts are listed
once with all the components they apply to.

収録ブロック数 / Blocks: ${blocks.length}
${
  missing.length
    ? `\nライセンスファイルが同梱されていないコンポーネント / Components shipping no license file (${missing.length}).
識別子は THIRD-PARTY-NOTICES.md に記載。必要に応じて上流から取得すること。
Their identifiers are recorded in THIRD-PARTY-NOTICES.md; fetch from upstream if required.
${missing.map((p) => `  ${p.name} ${p.version} (${p.license})`).join("\n")}\n`
    : ""
}

${body}`;

fs.writeFileSync(path.join(root, "THIRD-PARTY-LICENSES.txt"), licenses);

console.log(
  `THIRD-PARTY-NOTICES.md: ${rust.length} crates, ${npm.length} npm packages\n` +
    `THIRD-PARTY-LICENSES.txt: ${blocks.length} license blocks, ${missing.length} without a license file`,
);
