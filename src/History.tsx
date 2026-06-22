import { useEffect, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";

// 履歴ブラウザ：自動保存された過去のキャプチャをサムネイル一覧で表示し、
// クリックでエディタ再編集、ピンでデスクトップに貼り付ける。
// History browser: thumbnails of auto-saved captures; click to re-edit, pin to desktop.

type HistoryEntry = { path: string; name: string; kind: "image" | "video" };

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

  const reload = () =>
    invoke<HistoryEntry[]>("list_history")
      .then(setItems)
      .catch(() => setItems([]));

  useEffect(() => {
    reload();
  }, []);

  // 録画を保存先へ書き出す / Export a recording to the destination
  const saveVideo = async (path: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await invoke("save_recording", { path });
    } catch (e) {
      invoke("frontend_log", { message: `save_recording failed: ${e}` });
    } finally {
      setBusy(false);
    }
  };

  // 履歴から削除（録画・静止画 共通）/ Delete from history (recordings or stills)
  const discard = async (path: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await invoke("discard_recording", { path });
      await reload();
    } catch (e) {
      invoke("frontend_log", { message: `discard_recording failed: ${e}` });
    } finally {
      setBusy(false);
    }
  };

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
          className="ml-auto rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:border-[var(--accent)] hover:text-[var(--accent)]"
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
                {it.kind === "video" ? (
                  <video
                    src={convertFileSrc(it.path)}
                    className="h-28 w-full bg-black object-cover"
                    preload="metadata"
                    muted
                    controls
                  />
                ) : (
                  <img
                    src={convertFileSrc(it.path)}
                    className="h-28 w-full cursor-pointer object-cover"
                    loading="lazy"
                    draggable={false}
                    alt=""
                    onClick={() => edit(it.path)}
                  />
                )}
                {/* 種別バッジ / Kind badge */}
                {it.kind === "video" && (
                  <span className="pointer-events-none absolute left-1 top-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] text-white">
                    🎬 動画
                  </span>
                )}
                {/* ホバー操作 / Hover actions */}
                <div className="pointer-events-none absolute inset-0 flex items-end justify-end gap-1 bg-gradient-to-t from-black/70 to-transparent p-1 opacity-0 transition-opacity group-hover:opacity-100">
                  {it.kind === "video" ? (
                    <button
                      onClick={() => saveVideo(it.path)}
                      disabled={busy}
                      title="保存先へ書き出す"
                      className="pointer-events-auto rounded bg-zinc-800/90 px-2 py-1 text-[10px] text-zinc-100 hover:bg-zinc-700 disabled:opacity-50"
                    >
                      ⤓ 保存
                    </button>
                  ) : (
                    <>
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
                    </>
                  )}
                  <button
                    onClick={() => discard(it.path)}
                    disabled={busy}
                    title="履歴から削除"
                    className="pointer-events-auto rounded bg-zinc-800/90 px-2 py-1 text-[10px] text-zinc-100 hover:bg-red-600 disabled:opacity-50"
                  >
                    🗑
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
