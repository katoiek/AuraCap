import { useEffect, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";

// 履歴ブラウザ：自動保存された過去のキャプチャをサムネイル一覧で表示し、
// クリックでエディタ再編集、ピンでデスクトップに貼り付ける。
// History browser: thumbnails of auto-saved captures; click to re-edit, pin to desktop.

type HistoryEntry = { path: string; name: string };

// auracap_YYYYMMDD_HHMMSS_mmm.png → 表示用の日時 / Friendly date-time from the filename
function prettyName(name: string): string {
  const m = name.match(/auracap_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/);
  if (!m) return name;
  const [, y, mo, d, h, mi, s] = m;
  return `${y}/${mo}/${d} ${h}:${mi}:${s}`;
}

function History({ onBack }: { onBack: () => void }) {
  const [items, setItems] = useState<HistoryEntry[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    invoke<HistoryEntry[]>("list_history")
      .then(setItems)
      .catch(() => setItems([]));
  }, []);

  const edit = async (path: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await invoke("edit_history", { path });
    } catch (e) {
      invoke("frontend_log", { message: `edit_history failed: ${e}` });
    } finally {
      setBusy(false);
    }
  };

  const pin = async (path: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await invoke("pin_history", { path });
    } catch (e) {
      invoke("frontend_log", { message: `pin_history failed: ${e}` });
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flex h-screen w-screen flex-col bg-zinc-900 text-zinc-100">
      <header className="flex items-center gap-2 border-b border-zinc-800 px-4 py-2.5">
        <button
          onClick={onBack}
          title="戻る"
          className="grid h-7 w-7 place-items-center rounded-lg bg-zinc-800 text-sm text-zinc-300 hover:bg-zinc-700"
        >
          ←
        </button>
        <h1 className="text-base font-bold tracking-wide">履歴</h1>
        <span className="text-xs text-zinc-500">{items ? `${items.length}件` : ""}</span>
        <button
          onClick={() => invoke("open_history_dir")}
          className="ml-auto rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:border-amber-400 hover:text-amber-300"
        >
          フォルダを開く
        </button>
      </header>

      <div className="flex-1 overflow-auto p-3">
        {items === null ? (
          <p className="text-sm text-zinc-500">読み込み中…</p>
        ) : items.length === 0 ? (
          <p className="text-sm text-zinc-500">まだ履歴がありません。キャプチャすると自動で保存されます。</p>
        ) : (
          <div className="grid grid-cols-3 gap-2">
            {items.map((it) => (
              <div
                key={it.path}
                className="group relative overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950"
                title={prettyName(it.name)}
              >
                <img
                  src={convertFileSrc(it.path)}
                  className="h-28 w-full cursor-pointer object-cover"
                  loading="lazy"
                  draggable={false}
                  alt=""
                  onClick={() => edit(it.path)}
                />
                {/* ホバー操作 / Hover actions */}
                <div className="pointer-events-none absolute inset-0 flex items-end justify-end gap-1 bg-gradient-to-t from-black/70 to-transparent p-1 opacity-0 transition-opacity group-hover:opacity-100">
                  <button
                    onClick={() => edit(it.path)}
                    disabled={busy}
                    title="エディタで開く"
                    className="pointer-events-auto rounded bg-zinc-800/90 px-2 py-1 text-[10px] text-zinc-100 hover:bg-zinc-700 disabled:opacity-50"
                  >
                    ✎ 編集
                  </button>
                  <button
                    onClick={() => pin(it.path)}
                    disabled={busy}
                    title="デスクトップにピン留め"
                    className="pointer-events-auto rounded bg-zinc-800/90 px-2 py-1 text-[10px] text-zinc-100 hover:bg-zinc-700 disabled:opacity-50"
                  >
                    📌 ピン
                  </button>
                </div>
                <span className="block truncate px-1.5 py-1 text-[10px] text-zinc-500">
                  {prettyName(it.name)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

export default History;
