import { useCallback, useEffect, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/dpi";

// ヘッダー＋フッターの高さ（CSS px、概算）/ Approx header + footer height (CSS px)
const CHROME_H = 110;

// 動画プレビュー/エディタ窓：録画直後に開き、保存（保存先へ書き出し）/破棄ができる。
// 将来的にAIによる自動注釈（マニュアル生成）等を載せる土台。
// Video preview/editor window: opens right after recording to save (export) or discard.
// Foundation for future AI auto-annotation (manual generation), etc.

function VideoEditor() {
  const [path, setPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // 表示される度に最新テーマを反映（窓は常駐・使い回し）/ Re-apply the theme whenever shown (resident window)
    const applyTheme = () =>
      document
        .getElementById("root")
        ?.setAttribute("data-theme", localStorage.getItem("auracap_theme") || "graphite");
    applyTheme();
    const onVis = () => {
      if (document.visibilityState === "visible") applyTheme();
    };
    document.addEventListener("visibilitychange", onVis);

    // 初回：保留中の録画パスを取得 / First load: fetch the pending recording path
    invoke<string | null>("get_pending_recording").then((p) => setPath(p ?? null));
    // 使い回し窓：新しい録画が来たら更新 / Reused window: update when a new clip arrives
    const un = listen<string>("video-open", (e) => {
      setPath(e.payload);
      setBusy(false);
    });
    // 保存完了したら閉じる / Close once the export finishes
    const unSaved = listen("recording-saved", () => {
      invoke("close_video_editor").catch(() => {});
    });
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      un.then((f) => f());
      unSaved.then((f) => f());
    };
  }, []);

  // 動画の実寸に合わせてウィンドウをフィット（画面の9割でクランプ）
  // Fit the window to the video's real size (clamped to 90% of the screen)
  const fitToVideo = useCallback((v: HTMLVideoElement) => {
    if (!v.videoWidth || !v.videoHeight) return;
    const dpr = window.devicePixelRatio || 1;
    const availW = window.screen.availWidth * 0.9;
    const availH = window.screen.availHeight * 0.9 - CHROME_H;
    // intrinsicはデバイスpx相当なのでCSS pxへ / intrinsic px → CSS px
    let w = v.videoWidth / dpr;
    let h = v.videoHeight / dpr;
    const s = Math.min(1, availW / w, availH / h);
    w = Math.max(360, Math.round(w * s));
    h = Math.round(h * s);
    getCurrentWindow()
      .setSize(new LogicalSize(w, h + CHROME_H))
      .then(() => getCurrentWindow().center())
      .catch(() => {});
  }, []);

  const save = useCallback(() => {
    if (!path || busy) return;
    setBusy(true);
    invoke("save_recording", { path }).catch(() => setBusy(false));
  }, [path, busy]);

  const discard = useCallback(() => {
    if (!path || busy) return;
    setBusy(true);
    invoke("discard_recording", { path })
      .then(() => invoke("close_video_editor"))
      .catch(() => setBusy(false));
  }, [path, busy]);

  return (
    <main className="flex h-screen w-screen flex-col bg-zinc-900 text-zinc-100">
      <header className="flex items-center gap-2 border-b border-zinc-800 px-4 py-2.5">
        <h1 className="text-base font-bold tracking-wide">録画プレビュー</h1>
        <span className="text-xs text-zinc-500">保存先に書き出すか、破棄してください</span>
      </header>

      <div className="grid flex-1 place-items-center overflow-hidden bg-black p-3">
        {path ? (
          <video
            src={convertFileSrc(path)}
            className="max-h-full max-w-full rounded-lg"
            controls
            autoPlay
            loop
            muted
            onLoadedMetadata={(e) => fitToVideo(e.currentTarget)}
            onError={() =>
              invoke("frontend_log", { message: `video preview failed to load: ${path}` })
            }
          />
        ) : (
          <p className="text-sm text-zinc-500">録画を読み込み中…</p>
        )}
      </div>

      <footer className="flex gap-2 border-t border-zinc-800 px-4 py-3">
        <button
          onClick={save}
          disabled={busy || !path}
          className="flex-1 rounded-lg bg-[var(--accent)] px-3 py-2.5 text-sm font-bold text-zinc-900 transition-colors hover:bg-[var(--accent-strong)] disabled:opacity-50"
        >
          保存
        </button>
        <button
          onClick={discard}
          disabled={busy || !path}
          className="flex-1 rounded-lg bg-zinc-800 px-3 py-2.5 text-sm font-semibold text-zinc-300 transition-colors hover:bg-zinc-700 disabled:opacity-50"
        >
          破棄
        </button>
      </footer>
    </main>
  );
}

export default VideoEditor;
