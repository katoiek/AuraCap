import { useEffect, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";

// オーバーレイ表示情報（座標・サイズは物理ピクセル）
// Overlay info (coordinates/sizes in physical pixels)
type OverlayInfo = {
  monitorId: number;
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
  imagePath: string;
};

type Drag = { startX: number; startY: number; curX: number; curY: number };

// 誤クリック扱いにする最小サイズ（物理px） / Minimum size below which a drag is ignored (physical px)
const MIN_SELECTION_PX = 4;

function Overlay({ monitorId }: { monitorId: number }) {
  const [info, setInfo] = useState<OverlayInfo | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const submitting = useRef(false);

  useEffect(() => {
    invoke<OverlayInfo | null>("get_overlay_info", { monitorId })
      .then(setInfo)
      .catch((e) => invoke("frontend_log", { message: `get_overlay_info failed: ${e}` }));
  }, [monitorId]);

  useEffect(() => {
    // 予期しないJSエラーをRust側のログに転送する / Forward unexpected JS errors to the Rust log
    const onError = (e: ErrorEvent) =>
      invoke("frontend_log", { message: `overlay error: ${e.message}` });
    const onRejection = (e: PromiseRejectionEvent) =>
      invoke("frontend_log", { message: `overlay unhandled rejection: ${e.reason}` });
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Escでセッション全体を中断（全モニターのオーバーレイが閉じる）
      // Esc cancels the whole session (closes overlays on all monitors)
      if (e.key === "Escape") invoke("cancel_capture");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    setDrag({ startX: e.clientX, startY: e.clientY, curX: e.clientX, curY: e.clientY });
  };

  const onMouseMove = (e: React.MouseEvent) => {
    setDrag((d) => (d ? { ...d, curX: e.clientX, curY: e.clientY } : null));
  };

  const onMouseUp = async () => {
    if (!drag || submitting.current) return;
    const dpr = window.devicePixelRatio;
    const rect = dragRect(drag);
    const phys = {
      x: Math.round(rect.left * dpr),
      y: Math.round(rect.top * dpr),
      width: Math.round(rect.width * dpr),
      height: Math.round(rect.height * dpr),
    };
    if (phys.width < MIN_SELECTION_PX || phys.height < MIN_SELECTION_PX) {
      setDrag(null);
      return;
    }
    submitting.current = true;
    await invoke("finish_region_capture", { monitorId, ...phys });
  };

  if (!info) {
    return <div className="h-screen w-screen bg-black/40" />;
  }

  const rect = drag ? dragRect(drag) : null;
  const dpr = window.devicePixelRatio;

  return (
    <div
      className="relative h-screen w-screen cursor-crosshair select-none overflow-hidden"
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
    >
      {/* 凍結フレーム / Frozen frame */}
      <img
        src={convertFileSrc(info.imagePath)}
        className="absolute inset-0 h-full w-full"
        draggable={false}
        alt=""
        onError={() =>
          invoke("frontend_log", { message: `frozen frame failed to load: ${info.imagePath}` })
        }
      />
      {rect ? (
        // 選択矩形：外側は巨大なbox-shadowで減光する / Selection rect: outside dimmed by a huge box-shadow
        <div
          className="absolute border border-amber-400"
          style={{
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
            boxShadow: "0 0 0 100000px rgba(0, 0, 0, 0.35)",
          }}
        >
          <span className="absolute left-0 top-full mt-1 rounded bg-zinc-900/90 px-1.5 py-0.5 font-mono text-xs text-amber-300">
            {Math.round(rect.width * dpr)} × {Math.round(rect.height * dpr)}
          </span>
        </div>
      ) : (
        <div className="absolute inset-0 bg-black/35" />
      )}
    </div>
  );
}

function dragRect(d: Drag) {
  return {
    left: Math.min(d.startX, d.curX),
    top: Math.min(d.startY, d.curY),
    width: Math.abs(d.curX - d.startX),
    height: Math.abs(d.curY - d.startY),
  };
}

export default Overlay;
