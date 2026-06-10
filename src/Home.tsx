import { invoke } from "@tauri-apps/api/core";

// メインウィンドウ：キャプチャモードのボタンが主役、ショートカットは補助表示
// Main window: capture mode buttons are primary; shortcuts are shown as hints
const MODES = [
  {
    mode: "region",
    label: "矩形キャプチャ",
    description: "ドラッグで範囲を選択",
    keys: "PrtSc",
    icon: "⬚",
  },
  {
    mode: "window",
    label: "ウィンドウキャプチャ",
    description: "前面のウィンドウを撮影",
    keys: "Ctrl + PrtSc",
    icon: "🗔",
  },
  {
    mode: "fullscreen",
    label: "全画面キャプチャ",
    description: "カーソルのあるモニター全体",
    keys: "Shift + PrtSc",
    icon: "🖵",
  },
];

function Home() {
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
          <button
            key={m.mode}
            onClick={() => invoke("start_capture", { mode: m.mode })}
            className="group flex items-center gap-3 rounded-xl bg-zinc-800 px-4 py-3 text-left transition-colors hover:bg-zinc-700"
          >
            <span className="text-2xl text-amber-400">{m.icon}</span>
            <span className="flex-1">
              <span className="block text-sm font-semibold">{m.label}</span>
              <span className="block text-xs text-zinc-400">{m.description}</span>
            </span>
            <kbd className="rounded bg-zinc-700 px-2 py-1 font-mono text-[10px] text-amber-300 group-hover:bg-zinc-600">
              {m.keys}
            </kbd>
          </button>
        ))}
      </section>

      <button
        onClick={() => invoke("open_history_dir")}
        className="mt-auto rounded-lg border border-zinc-700 px-4 py-2 text-xs text-zinc-300 transition-colors hover:border-amber-400 hover:text-amber-300"
      >
        履歴フォルダを開く
      </button>
    </main>
  );
}

export default Home;
