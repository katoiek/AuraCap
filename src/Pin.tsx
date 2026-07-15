import { useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { PhysicalSize } from "@tauri-apps/api/dpi";

// 付箋ピン留め：常に最前面のフローティング窓。
// ドラッグで移動、ダブルクリックで等倍(100%)表示、✎で再編集、✕で閉じる。
// Pin-to-desktop: always-on-top floating window. Drag to move, double-click for
// 1:1 (100%) size, ✎ to re-edit, ✕ to close.
function Pin({ id }: { id: number }) {
  // 画像の実寸（物理px） / Image natural size (physical px)
  const natural = useRef<{ w: number; h: number } | null>(null);
  const [busy, setBusy] = useState(false);

  // 等倍(100%)表示：窓を画像の実寸に合わせる（画面の95%でクランプ）
  // 1:1 view: size the window to the image's native pixels (clamped to 95% of screen)
  const resizeToNative = async () => {
    const n = natural.current;
    if (!n) return;
    const dpr = window.devicePixelRatio || 1;
    const maxW = window.screen.availWidth * dpr * 0.95;
    const maxH = window.screen.availHeight * dpr * 0.95;
    const scale = Math.min(1, maxW / n.w, maxH / n.h);
    try {
      await getCurrentWindow().setSize(
        new PhysicalSize(Math.max(1, Math.round(n.w * scale)), Math.max(1, Math.round(n.h * scale))),
      );
    } catch {
      /* ウィンドウ操作不可時は無視 / Ignore when unavailable */
    }
  };

  const reopenEditor = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await invoke("edit_pin", { id });
    } catch (e) {
      invoke("frontend_log", { message: `edit_pin failed: ${e}` });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="group relative h-screen w-screen overflow-hidden bg-zinc-900">
      {/* ドラッグ/ダブルクリック領域。startDraggingで移動、dblで等倍 */}
      {/* Drag/double-click layer: startDragging to move, dblclick for 1:1 */}
      <div
        className="absolute inset-0"
        onMouseDown={(e) => {
          // 単クリックの押下でのみドラッグ開始（ダブルクリック2回目は無視）
          // Start dragging only on a single-click press (skip the 2nd of a double-click)
          if (e.button === 0 && e.detail === 1) getCurrentWindow().startDragging();
        }}
        onDoubleClick={resizeToNative}
      >
        <img
          src={convertFileSrc(String(id), "pin")}
          className="pointer-events-none h-full w-full object-contain"
          draggable={false}
          alt=""
          onLoad={(e) => {
            natural.current = { w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight };
          }}
        />
      </div>

      {/* 操作ボタン（ホバーで表示） / Action buttons (shown on hover) */}
      <div className="absolute right-1 top-1 z-10 hidden gap-1 group-hover:flex">
        <button
          onClick={reopenEditor}
          disabled={busy}
          title="エディタで開く"
          className="grid h-5 w-5 place-items-center rounded bg-black/60 text-xs text-white hover:bg-black/80 disabled:opacity-50"
        >
          ✎
        </button>
        <button
          onClick={() => getCurrentWindow().close()}
          title="閉じる"
          className="grid h-5 w-5 place-items-center rounded bg-black/60 text-xs text-white hover:bg-black/80"
        >
          ✕
        </button>
      </div>
    </div>
  );
}

export default Pin;
