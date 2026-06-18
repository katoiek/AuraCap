import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/dpi";
import History from "./History";

// メインウィンドウ：キャプチャボタンが主役。設定（⚙）でホットキー・コード生成を構成する
// Main window: capture buttons are primary. The ⚙ settings view configures hotkeys & codegen.

type Settings = {
  closeToTray: boolean;
  hotkeysEnabled: boolean;
  hotkeyRegion: string;
  hotkeyWindow: string;
  hotkeyFullscreen: string;
  anthropicApiKey: string;
  codegenProvider: string; // "claude" | "ollama"
  ollamaUrl: string;
  ollamaModel: string;
  saveMode: string; // "ask" | "fixed" | "last"
  saveDir: string; // 既定の保存先（空＝ピクチャ）/ Default save folder (empty = Pictures)
  lastSaveDir: string;
  fileNameTemplate: string;
};

const DEFAULT_SETTINGS: Settings = {
  closeToTray: true,
  hotkeysEnabled: true,
  hotkeyRegion: "PrintScreen",
  hotkeyWindow: "Ctrl+PrintScreen",
  hotkeyFullscreen: "Shift+PrintScreen",
  anthropicApiKey: "",
  codegenProvider: "claude",
  ollamaUrl: "http://127.0.0.1:11434",
  ollamaModel: "qwen2.5vl",
  saveMode: "ask",
  saveDir: "",
  lastSaveDir: "",
  fileNameTemplate: "auracap_{date}_{time}",
};

// テンプレートをプレビュー文字列に展開（バックエンドの build_file_name と同じ規則）
// Expand a template into a preview string (mirrors the backend build_file_name rules)
function previewFileName(tmpl: string): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const YYYY = String(d.getFullYear());
  const MM = p(d.getMonth() + 1);
  const DD = p(d.getDate());
  const HH = p(d.getHours());
  const mm = p(d.getMinutes());
  const ss = p(d.getSeconds());
  const map: Record<string, string> = {
    "{date}": `${YYYY}${MM}${DD}`,
    "{time}": `${HH}${mm}${ss}`,
    "{YYYY}": YYYY,
    "{MM}": MM,
    "{DD}": DD,
    "{HH}": HH,
    "{mm}": mm,
    "{ss}": ss,
  };
  let s = tmpl.trim() || "auracap_{date}_{time}";
  for (const [k, v] of Object.entries(map)) s = s.split(k).join(v);
  s = s.replace(/[\\/:*?"<>|]/g, "_").trim() || "auracap";
  return `${s}.png`;
}

const MODES = [
  {
    mode: "region",
    key: "hotkeyRegion" as const,
    label: "矩形キャプチャ",
    description: "ドラッグで範囲を選択",
    icon: "⬚",
  },
  {
    mode: "window",
    key: "hotkeyWindow" as const,
    label: "ウィンドウキャプチャ",
    description: "前面のウィンドウを撮影",
    icon: "🗔",
  },
  {
    mode: "fullscreen",
    key: "hotkeyFullscreen" as const,
    label: "全画面キャプチャ",
    description: "カーソルのあるモニター全体",
    icon: "🖵",
  },
];

// 保存形式（例 "Ctrl+KeyA"）→ 表示形式（"Ctrl + A"） / Stored combo → friendly display
const ARROWS: Record<string, string> = {
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
};
function prettyHotkey(combo: string): string {
  if (!combo) return "なし";
  return combo
    .split("+")
    .map((part) => {
      if (part === "PrintScreen") return "PrtSc";
      if (part === "Super") return "Win";
      if (part.startsWith("Key")) return part.slice(3);
      if (part.startsWith("Digit")) return part.slice(5);
      if (part in ARROWS) return ARROWS[part];
      return part;
    })
    .join(" + ");
}

// キーイベント→保存形式（W3Cコード名）。修飾キー単体はnull
// Key event → stored combo (W3C code names); bare modifiers yield null
const MODIFIER_CODES = new Set([
  "ControlLeft",
  "ControlRight",
  "ShiftLeft",
  "ShiftRight",
  "AltLeft",
  "AltRight",
  "MetaLeft",
  "MetaRight",
]);
function comboFromEvent(e: KeyboardEvent): string | null {
  if (!e.code || MODIFIER_CODES.has(e.code)) return null;
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.shiftKey) mods.push("Shift");
  if (e.altKey) mods.push("Alt");
  if (e.metaKey) mods.push("Super");
  return [...mods, e.code].join("+");
}

function Home() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [view, setView] = useState<"main" | "settings" | "history">("main");
  const [recording, setRecording] = useState<keyof Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  // ホットキー登録の警告（他アプリ使用中のキー） / Hotkey warnings (keys held by other apps)
  const [hotkeyWarnings, setHotkeyWarnings] = useState<string[]>([]);
  // テキスト設定の下書き（nullなら未編集） / Text-settings draft (null = untouched)
  const [draft, setDraft] = useState<Partial<Settings> | null>(null);
  // Ollamaのインストール済みモデル一覧（null=未取得/取得失敗） / Installed Ollama models (null = not loaded / failed)
  const [ollamaModels, setOllamaModels] = useState<string[] | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  // ログオン時の自動起動（プラグインのレジストリ状態を直接読む） / Auto-launch state (read from the plugin)
  const [autostart, setAutostart] = useState(false);
  // 撮影遅延（秒）。消えるUIを撮るため。セッション内の一時選択 / Capture delay (sec) for transient UI
  const [delay, setDelay] = useState(0);
  const settingsRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    invoke<Settings>("get_settings")
      .then(setSettings)
      .catch(() => setSettings(DEFAULT_SETTINGS));
    invoke<boolean>("get_autostart")
      .then(setAutostart)
      .catch(() => {});
  }, []);

  const toggleAutostart = useCallback(async () => {
    const next = !autostart;
    try {
      await invoke("set_autostart", { enabled: next });
      setAutostart(next);
    } catch (e) {
      setError(String(e));
    }
  }, [autostart]);

  const applySettings = useCallback(async (next: Settings) => {
    try {
      const warnings = await invoke<string[]>("save_settings", { settings: next });
      setSettings(next);
      setHotkeyWarnings(Array.isArray(warnings) ? warnings : []);
      setError(null);
      return true;
    } catch (e) {
      setError(String(e));
      return false;
    }
  }, []);

  // 保存先フォルダをダイアログで選ぶ / Pick the default save folder via a dialog
  const pickSaveDir = useCallback(async () => {
    if (!settings) return;
    try {
      const dir = await invoke<string | null>("pick_save_dir");
      if (dir) applySettings({ ...settings, saveDir: dir });
    } catch (e) {
      setError(String(e));
    }
  }, [settings, applySettings]);

  // Ollamaの /api/tags からモデル一覧を取得する / Fetch the model list from Ollama's /api/tags
  const fetchOllamaModels = useCallback(async (url: string) => {
    setLoadingModels(true);
    try {
      const base = url.trim().replace(/\/+$/, "") || DEFAULT_SETTINGS.ollamaUrl;
      const res = await fetch(`${base}/api/tags`);
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = await res.json();
      const names: string[] = (data.models ?? [])
        .map((m: { name: string }) => m.name)
        .sort((a: string, b: string) => a.localeCompare(b));
      setOllamaModels(names);
    } catch {
      // 未起動・URL誤り等。手入力にフォールバックさせる / Not running / bad URL → fall back to manual entry
      setOllamaModels(null);
    } finally {
      setLoadingModels(false);
    }
  }, []);

  // 設定画面でOllama選択中はモデル一覧を自動取得 / Auto-fetch models while Ollama is selected on the settings view
  useEffect(() => {
    if (view === "settings" && settings?.codegenProvider === "ollama") {
      fetchOllamaModels(settings.ollamaUrl);
    }
  }, [view, settings?.codegenProvider, settings?.ollamaUrl, fetchOllamaModels]);

  // 録取中のキーイベント / Key capture while recording
  useEffect(() => {
    if (!recording || !settings) return;
    const finish = (combo: string | null) => {
      setRecording(null);
      if (combo) {
        applySettings({ ...settings, [recording]: combo });
      } else {
        invoke("resume_hotkeys").catch(() => {});
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      if (e.code === "Escape") return finish(null);
      const combo = comboFromEvent(e);
      if (combo) finish(combo);
    };
    // PrintScreenはkeydownが発火しない環境があるためkeyupでも拾う
    // Some environments fire only keyup for PrintScreen
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "PrintScreen") {
        e.preventDefault();
        finish(comboFromEvent(e));
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
    };
  }, [recording, settings, applySettings]);

  const startRecording = (key: keyof Settings) => {
    setError(null);
    setRecording(key);
    // 録取中の誤発火を防ぐ / Avoid firing global hotkeys mid-recording
    invoke("suspend_hotkeys").catch(() => {});
  };

  // 設定画面はコンテンツ高に合わせてウィンドウを縦リサイズ、メイン画面は既定サイズへ戻す
  // The settings view resizes the window to fit its content height; main returns to default
  useEffect(() => {
    const win = getCurrentWindow();
    if (view === "main") {
      win.setSize(new LogicalSize(480, 360)).catch(() => {});
      return;
    }
    if (view === "history") {
      // 履歴ブラウザは一覧が見やすい固定サイズ（内部スクロール）/ Fixed browser size, scrolls inside
      win.setSize(new LogicalSize(760, 560)).catch(() => {});
      return;
    }
    const el = settingsRef.current;
    if (!el) return;
    let raf = 0;
    const fit = async () => {
      try {
        // タイトルバー等のウィンドウ枠の高さ（CSS px）を実測して足し込む
        // Measure the window chrome (title bar etc.) in CSS px and add it
        const scale = await win.scaleFactor();
        const outer = await win.outerSize();
        const chrome = outer.height / scale - window.innerHeight;
        const target = Math.min(Math.max(el.scrollHeight + chrome, 200), 1000);
        await win.setSize(new LogicalSize(480, Math.ceil(target)));
      } catch {
        /* ウィンドウ操作不可時は無視 / Ignore when the window op is unavailable */
      }
    };
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(fit);
    });
    ro.observe(el);
    fit();
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [view]);

  const provider = settings?.codegenProvider ?? "claude";

  // ---- 履歴ブラウザ / History browser ----
  if (view === "history") {
    return <History onBack={() => setView("main")} />;
  }

  // ---- メイン画面 / Main view ----
  if (view !== "settings") {
    return (
      <main className="flex h-screen w-screen flex-col gap-4 bg-zinc-900 p-5 text-zinc-100">
        <header className="flex items-center justify-between">
          <h1 className="text-lg font-bold tracking-wide">
            Aura<span className="text-amber-400">Cap</span>
          </h1>
          <div className="flex items-center gap-2">
            <p className="text-xs text-zinc-500">
              {settings?.closeToTray ? "✕で常駐" : "✕で終了"}
            </p>
            <button
              onClick={() => setView("settings")}
              title="設定"
              className="grid h-7 w-7 place-items-center rounded-lg bg-zinc-800 text-sm text-zinc-300 hover:bg-zinc-700"
            >
              ⚙
            </button>
          </div>
        </header>

        {/* 撮影遅延セレクタ / Capture delay selector */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-zinc-400">遅延</span>
          <div className="flex gap-1">
            {[0, 3, 5].map((d) => (
              <button
                key={d}
                onClick={() => setDelay(d)}
                className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
                  delay === d
                    ? "bg-amber-400 font-semibold text-zinc-900"
                    : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
                }`}
              >
                {d === 0 ? "なし" : `${d}秒`}
              </button>
            ))}
          </div>
          {delay > 0 && (
            <span className="text-xs text-zinc-500">撮影まで{delay}秒待ちます</span>
          )}
        </div>

        <section className="flex flex-col gap-2">
          {MODES.map((m) => (
            <button
              key={m.mode}
              onClick={() => invoke("start_capture", { mode: m.mode, delay })}
              className="group flex items-center gap-3 rounded-xl bg-zinc-800 px-4 py-3 text-left transition-colors hover:bg-zinc-700"
            >
              <span className="text-2xl text-amber-400">{m.icon}</span>
              <span className="flex-1">
                <span className="block text-sm font-semibold">{m.label}</span>
                <span className="block text-xs text-zinc-400">{m.description}</span>
              </span>
              {settings?.hotkeysEnabled && (
                <kbd className="rounded bg-zinc-700 px-2 py-1 font-mono text-[10px] text-amber-300 group-hover:bg-zinc-600">
                  {prettyHotkey(settings[m.key])}
                </kbd>
              )}
            </button>
          ))}
        </section>

        <button
          onClick={() => setView("history")}
          className="mt-auto rounded-lg border border-zinc-700 px-4 py-2 text-xs text-zinc-300 transition-colors hover:border-amber-400 hover:text-amber-300"
        >
          履歴を見る
        </button>
      </main>
    );
  }

  // ---- 設定画面 / Settings view ----
  // h-screenにせず自然高にして、その高さへウィンドウを合わせる（上のuseEffect）
  // Natural height (no h-screen) so the window can be fit to it (see the effect above)
  return (
    <main ref={settingsRef} className="flex w-screen flex-col gap-4 bg-zinc-900 p-5 text-zinc-100">
      <header className="flex items-center gap-2">
        <button
          onClick={() => {
            setView("main");
            setRecording(null);
            setDraft(null);
          }}
          title="戻る"
          className="grid h-7 w-7 place-items-center rounded-lg bg-zinc-800 text-sm text-zinc-300 hover:bg-zinc-700"
        >
          ←
        </button>
        <h1 className="text-base font-bold tracking-wide">設定</h1>
      </header>

      {/* 全般 / General */}
      <section className="flex flex-col gap-2">
        <span className="text-sm font-semibold">全般</span>

        <div className="flex items-center justify-between">
          <span className="text-xs text-zinc-300">ログオン時に自動起動</span>
          <button
            onClick={toggleAutostart}
            role="switch"
            aria-checked={autostart}
            className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
              autostart ? "bg-amber-400" : "bg-zinc-700"
            }`}
          >
            <span
              className={`absolute top-1 h-4 w-4 rounded-full bg-white transition-all ${
                autostart ? "left-6" : "left-1"
              }`}
            />
          </button>
        </div>

        <div className="flex items-center justify-between">
          <span className="text-xs text-zinc-300">✕ボタンでトレイに常駐</span>
          <button
            onClick={() =>
              settings && applySettings({ ...settings, closeToTray: !settings.closeToTray })
            }
            role="switch"
            aria-checked={settings?.closeToTray ?? true}
            className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
              settings?.closeToTray ? "bg-amber-400" : "bg-zinc-700"
            }`}
          >
            <span
              className={`absolute top-1 h-4 w-4 rounded-full bg-white transition-all ${
                settings?.closeToTray ? "left-6" : "left-1"
              }`}
            />
          </button>
        </div>
        <p className="text-xs text-zinc-500">
          オン: ✕で閉じてもトレイに常駐します。オフ: ✕でアプリを終了します。
        </p>

        {/* 保存先 / Save destination */}
        <div className="mt-1 flex items-center justify-between">
          <span className="text-xs text-zinc-300">保存先の動作</span>
          <select
            value={settings?.saveMode ?? "ask"}
            onChange={(e) =>
              settings && applySettings({ ...settings, saveMode: e.target.value })
            }
            className="rounded bg-zinc-800 px-2 py-1 text-xs text-zinc-100"
          >
            <option value="ask">毎回確認（ダイアログ）</option>
            <option value="fixed">指定フォルダに自動保存</option>
            <option value="last">最後の保存先を記憶</option>
          </select>
        </div>

        {/* "last"以外は既定/保存先フォルダを指定 / Folder applies except in "last" mode */}
        {settings?.saveMode !== "last" && (
          <div className="flex items-center gap-2">
            <span
              className="flex-1 truncate rounded bg-zinc-900 px-2 py-1 text-xs text-zinc-400"
              title={settings?.saveDir || "ピクチャ（既定）"}
            >
              {settings?.saveDir || "ピクチャ（既定）"}
            </span>
            <button
              onClick={pickSaveDir}
              className="shrink-0 rounded bg-zinc-700 px-2 py-1 text-xs hover:bg-zinc-600"
            >
              変更
            </button>
            {settings?.saveDir && (
              <button
                onClick={() => settings && applySettings({ ...settings, saveDir: "" })}
                className="shrink-0 rounded bg-zinc-800 px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-700"
                title="ピクチャに戻す"
              >
                ✕
              </button>
            )}
          </div>
        )}
        <p className="text-xs text-zinc-500">
          {settings?.saveMode === "fixed"
            ? "保存ボタンで確認なしに上記フォルダへ保存します。"
            : settings?.saveMode === "last"
              ? "保存ダイアログが前回保存した場所を初期表示します。"
              : "保存ダイアログが上記フォルダを初期表示します。"}
        </p>

        {/* ファイル名テンプレート / File-name template */}
        <div className="mt-1 flex items-center justify-between">
          <span className="text-xs text-zinc-300">ファイル名の規則</span>
          <span className="text-xs text-zinc-500 truncate max-w-[55%] text-right" title={previewFileName(draft?.fileNameTemplate ?? settings?.fileNameTemplate ?? "")}>
            例: {previewFileName(draft?.fileNameTemplate ?? settings?.fileNameTemplate ?? "")}
          </span>
        </div>
        <input
          type="text"
          value={draft?.fileNameTemplate ?? settings?.fileNameTemplate ?? ""}
          onChange={(e) => setDraft((d) => ({ ...d, fileNameTemplate: e.target.value }))}
          onBlur={async () => {
            if (settings && draft?.fileNameTemplate !== undefined) {
              if (await applySettings({ ...settings, fileNameTemplate: draft.fileNameTemplate }))
                setDraft((d) => (d ? { ...d, fileNameTemplate: undefined } : d));
            }
          }}
          placeholder="auracap_{date}_{time}"
          className="rounded-lg border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-600 focus:border-amber-400 focus:outline-none"
        />
        <p className="text-xs text-zinc-500">
          使えるトークン: {"{date} {time} {YYYY} {MM} {DD} {HH} {mm} {ss}"}（拡張子 .png は自動付与）
        </p>
      </section>

      <div className="h-px bg-zinc-800" />

      {/* ホットキー設定 / Hotkey settings */}
      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold">ホットキー</span>
          <button
            onClick={() =>
              settings && applySettings({ ...settings, hotkeysEnabled: !settings.hotkeysEnabled })
            }
            role="switch"
            aria-checked={settings?.hotkeysEnabled ?? false}
            className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
              settings?.hotkeysEnabled ? "bg-amber-400" : "bg-zinc-700"
            }`}
          >
            <span
              className={`absolute top-1 h-4 w-4 rounded-full bg-white transition-all ${
                settings?.hotkeysEnabled ? "left-6" : "left-1"
              }`}
            />
          </button>
        </div>
        <p className="text-xs text-zinc-500">
          グローバルショートカットでキャプチャを起動します。他アプリと競合する場合はオフにできます。
        </p>

        {settings?.hotkeysEnabled && (
          <div className="flex flex-col gap-1.5">
            {MODES.map((m) => (
              <div key={m.mode} className="flex items-center justify-between rounded-lg bg-zinc-800 px-3 py-2">
                <span className="text-xs text-zinc-300">{m.label}</span>
                <button
                  onClick={() => startRecording(m.key)}
                  title="クリックしてショートカットを変更"
                  className={`rounded px-2 py-1 font-mono text-[10px] transition-colors ${
                    recording === m.key
                      ? "bg-amber-400 text-zinc-900"
                      : "bg-zinc-700 text-amber-300 hover:bg-zinc-600"
                  }`}
                >
                  {recording === m.key ? "キーを入力…" : settings ? prettyHotkey(settings[m.key]) : "…"}
                </button>
              </div>
            ))}
            {recording && (
              <p className="text-xs text-zinc-400">
                設定したいキーの組み合わせを押してください（Escでキャンセル）
              </p>
            )}
            {hotkeyWarnings.length > 0 && (
              <p className="text-xs text-amber-400">
                次のキーは他アプリが使用中のため無効です: {hotkeyWarnings.join("、")}
                。別のキーに変更してください。
              </p>
            )}
          </div>
        )}
      </section>

      <div className="h-px bg-zinc-800" />

      {/* コード生成設定 / Codegen settings */}
      <section className="flex flex-col gap-2">
        <span className="text-sm font-semibold">コード生成（Screenshot-to-Code）</span>

        <div className="flex items-center gap-2">
          <label className="w-16 shrink-0 text-xs text-zinc-400" htmlFor="codegen-provider">
            エンジン
          </label>
          <select
            id="codegen-provider"
            value={provider}
            onChange={(e) => settings && applySettings({ ...settings, codegenProvider: e.target.value })}
            className="flex-1 rounded-lg border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-xs text-zinc-200 focus:border-amber-400 focus:outline-none"
          >
            <option value="claude">Claude API</option>
            <option value="ollama">Ollama（ローカル）</option>
          </select>
        </div>

        {provider === "claude" ? (
          <div className="flex items-center gap-2">
            <label className="w-16 shrink-0 text-xs text-zinc-400" htmlFor="api-key">
              APIキー
            </label>
            <input
              id="api-key"
              type="password"
              placeholder="sk-ant-…"
              value={draft?.anthropicApiKey ?? settings?.anthropicApiKey ?? ""}
              onChange={(e) => setDraft((d) => ({ ...d, anthropicApiKey: e.target.value }))}
              className="min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-600 focus:border-amber-400 focus:outline-none"
            />
            {draft?.anthropicApiKey !== undefined && (
              <button
                onClick={async () => {
                  if (!settings) return;
                  if (await applySettings({ ...settings, anthropicApiKey: (draft.anthropicApiKey ?? "").trim() }))
                    setDraft(null);
                }}
                className="rounded-lg bg-amber-400 px-3 py-1.5 text-xs font-semibold text-zinc-900 hover:bg-amber-300"
              >
                保存
              </button>
            )}
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <label className="w-16 shrink-0 text-xs text-zinc-400">モデル</label>
              {ollamaModels && ollamaModels.length > 0 ? (
                // 一覧取得成功 → ドロップダウン（選択で即保存） / Models loaded → dropdown (saves on change)
                <select
                  value={settings?.ollamaModel ?? ""}
                  onChange={(e) => settings && applySettings({ ...settings, ollamaModel: e.target.value })}
                  className="min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-xs text-zinc-200 focus:border-amber-400 focus:outline-none"
                >
                  {settings?.ollamaModel && !ollamaModels.includes(settings.ollamaModel) && (
                    <option value={settings.ollamaModel}>{settings.ollamaModel}（未インストール？）</option>
                  )}
                  {ollamaModels.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              ) : (
                // 一覧未取得（未起動等）→ 手入力にフォールバック / No list → manual entry
                <input
                  type="text"
                  placeholder={loadingModels ? "モデル一覧を取得中…" : "モデル名（例: qwen2.5vl）"}
                  value={draft?.ollamaModel ?? settings?.ollamaModel ?? ""}
                  onChange={(e) => setDraft((d) => ({ ...d, ollamaModel: e.target.value }))}
                  onBlur={async () => {
                    if (settings && draft?.ollamaModel !== undefined) {
                      if (await applySettings({ ...settings, ollamaModel: (draft.ollamaModel ?? "").trim() }))
                        setDraft((d) => ({ ...d, ollamaModel: undefined }));
                    }
                  }}
                  className="min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-600 focus:border-amber-400 focus:outline-none"
                />
              )}
            </div>
            <div className="flex items-center gap-2">
              <label className="w-16 shrink-0 text-xs text-zinc-400" htmlFor="ollama-url">
                URL
              </label>
              <input
                id="ollama-url"
                type="text"
                placeholder="http://127.0.0.1:11434"
                value={draft?.ollamaUrl ?? settings?.ollamaUrl ?? ""}
                onChange={(e) => setDraft((d) => ({ ...d, ollamaUrl: e.target.value }))}
                onBlur={async () => {
                  if (settings && draft?.ollamaUrl !== undefined) {
                    const url = (draft.ollamaUrl ?? "").trim() || DEFAULT_SETTINGS.ollamaUrl;
                    if (await applySettings({ ...settings, ollamaUrl: url }))
                      setDraft((d) => ({ ...d, ollamaUrl: undefined }));
                  }
                }}
                className="min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-600 focus:border-amber-400 focus:outline-none"
              />
              <button
                onClick={() => fetchOllamaModels(draft?.ollamaUrl ?? settings?.ollamaUrl ?? DEFAULT_SETTINGS.ollamaUrl)}
                disabled={loadingModels}
                title="モデル一覧を再取得"
                className="rounded-lg border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-300 hover:border-amber-400 hover:text-amber-300 disabled:opacity-50"
              >
                {loadingModels ? "…" : "🔄"}
              </button>
            </div>
            {!loadingModels && ollamaModels === null && (
              <p className="text-xs text-zinc-500">
                Ollamaに接続できません。起動状態とURLを確認し🔄で再取得するか、モデル名を直接入力してください。
              </p>
            )}
            {ollamaModels !== null && ollamaModels.length === 0 && (
              <p className="text-xs text-zinc-500">
                インストール済みモデルがありません（例: `ollama pull qwen2.5vl`）。
              </p>
            )}
          </>
        )}
      </section>

      {error && <p className="text-xs text-red-400">{error}</p>}

      <button
        onClick={() =>
          settings &&
          applySettings({
            ...settings,
            hotkeysEnabled: DEFAULT_SETTINGS.hotkeysEnabled,
            hotkeyRegion: DEFAULT_SETTINGS.hotkeyRegion,
            hotkeyWindow: DEFAULT_SETTINGS.hotkeyWindow,
            hotkeyFullscreen: DEFAULT_SETTINGS.hotkeyFullscreen,
          })
        }
        title="ショートカットを初期設定に戻す（APIキー・Ollama設定は保持）"
        className="mt-2 rounded-lg border border-zinc-700 px-4 py-2 text-xs text-zinc-400 transition-colors hover:border-zinc-500 hover:text-zinc-200"
      >
        ショートカットを既定に戻す
      </button>
    </main>
  );
}

export default Home;
