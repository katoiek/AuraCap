import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

// メインウィンドウ：キャプチャモードのボタンが主役、ショートカットは補助表示
// ショートカットチップをクリックするとキーの組み合わせを録取して変更できる
// Main window: capture mode buttons are primary; shortcuts are shown as hints.
// Clicking a shortcut chip records a new key combination.

type Settings = {
  hotkeyRegion: string;
  hotkeyWindow: string;
  hotkeyFullscreen: string;
  anthropicApiKey: string;
};

const DEFAULT_SETTINGS: Settings = {
  hotkeyRegion: "PrintScreen",
  hotkeyWindow: "Ctrl+PrintScreen",
  hotkeyFullscreen: "Shift+PrintScreen",
  anthropicApiKey: "",
};

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
  const [recording, setRecording] = useState<keyof Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  // APIキー入力の下書き（nullなら未編集） / API key draft (null = untouched)
  const [keyDraft, setKeyDraft] = useState<string | null>(null);

  useEffect(() => {
    invoke<Settings>("get_settings")
      .then(setSettings)
      .catch(() => setSettings(DEFAULT_SETTINGS));
  }, []);

  const applySettings = useCallback(async (next: Settings) => {
    try {
      await invoke("save_settings", { settings: next });
      setSettings(next);
      setError(null);
      return true;
    } catch (e) {
      setError(String(e));
      // 失敗時はバックエンドが旧設定へ戻している / Backend already rolled back
      await invoke("resume_hotkeys").catch(() => {});
      return false;
    }
  }, []);

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

  return (
    <main className="flex h-screen w-screen flex-col gap-4 bg-zinc-900 p-5 text-zinc-100">
      <header className="flex items-baseline justify-between">
        <h1 className="text-lg font-bold tracking-wide">
          Aura<span className="text-amber-400">Cap</span>
        </h1>
        <p className="text-xs text-zinc-500">トレイ常駐中</p>
      </header>

      <section className="flex flex-col gap-2">
        {MODES.map((m) => (
          <div
            key={m.mode}
            className="group flex items-center gap-3 rounded-xl bg-zinc-800 px-4 py-3 transition-colors hover:bg-zinc-700"
          >
            <button
              onClick={() => invoke("start_capture", { mode: m.mode })}
              className="flex flex-1 items-center gap-3 text-left"
            >
              <span className="text-2xl text-amber-400">{m.icon}</span>
              <span className="flex-1">
                <span className="block text-sm font-semibold">{m.label}</span>
                <span className="block text-xs text-zinc-400">{m.description}</span>
              </span>
            </button>
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
      </section>

      {recording && (
        <p className="text-xs text-zinc-400">
          設定したいキーの組み合わせを押してください（Escでキャンセル）
        </p>
      )}
      {error && <p className="text-xs text-red-400">{error}</p>}

      {/* Screenshot-to-Code用のClaude APIキー / Claude API key for Screenshot-to-Code */}
      <div className="flex items-center gap-2">
        <label className="shrink-0 text-xs text-zinc-400" htmlFor="api-key">
          Claude APIキー
        </label>
        <input
          id="api-key"
          type="password"
          placeholder="sk-ant-…（コード生成に使用）"
          value={keyDraft ?? settings?.anthropicApiKey ?? ""}
          onChange={(e) => setKeyDraft(e.target.value)}
          className="min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-600 focus:border-amber-400 focus:outline-none"
        />
        {keyDraft !== null && (
          <button
            onClick={async () => {
              if (!settings) return;
              if (await applySettings({ ...settings, anthropicApiKey: keyDraft.trim() })) {
                setKeyDraft(null);
              }
            }}
            className="rounded-lg bg-amber-400 px-3 py-1.5 text-xs font-semibold text-zinc-900 hover:bg-amber-300"
          >
            保存
          </button>
        )}
      </div>

      <div className="mt-auto flex items-center gap-2">
        <button
          onClick={() => invoke("open_history_dir")}
          className="flex-1 rounded-lg border border-zinc-700 px-4 py-2 text-xs text-zinc-300 transition-colors hover:border-amber-400 hover:text-amber-300"
        >
          履歴フォルダを開く
        </button>
        <button
          onClick={() =>
            settings &&
            applySettings({ ...DEFAULT_SETTINGS, anthropicApiKey: settings.anthropicApiKey })
          }
          title="ショートカットを初期設定に戻す"
          className="rounded-lg border border-zinc-700 px-3 py-2 text-xs text-zinc-400 transition-colors hover:border-zinc-500 hover:text-zinc-200"
        >
          既定に戻す
        </button>
      </div>
    </main>
  );
}

export default Home;
