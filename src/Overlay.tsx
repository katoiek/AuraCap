import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

// オーバーレイ表示情報（座標・サイズは物理ピクセル）
// Overlay info (coordinates/sizes in physical pixels)
type OverlayInfo = {
  monitorId: number;
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
  mode: "region" | "window";
  windows: PickableWindow[];
};

type PickableWindow = {
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

// CSSピクセルの矩形 / Rectangle in CSS pixels
type Rect = { left: number; top: number; width: number; height: number };

type Phase = "pick" | "drag" | "adjust";

type Gesture =
  | { kind: "draw"; ax: number; ay: number }
  | { kind: "move"; ox: number; oy: number; start: Rect }
  | { kind: "resize"; handle: Handle; ax: number; ay: number; start: Rect };

const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;
type Handle = (typeof HANDLES)[number];

const HANDLE_CURSOR: Record<Handle, string> = {
  nw: "nwse-resize",
  se: "nwse-resize",
  ne: "nesw-resize",
  sw: "nesw-resize",
  n: "ns-resize",
  s: "ns-resize",
  e: "ew-resize",
  w: "ew-resize",
};

// 誤クリック扱いにする最小サイズ（物理px） / Minimum size below which a drag is ignored (physical px)
const MIN_SELECTION_PX = 4;

// ルーペ（拡大鏡）の表示サイズと倍率：1pxを8px角で表示する
// Loupe size & zoom: each source pixel shows as an 8px cell
const LOUPE_SIZE = 144;
const LOUPE_ZOOM = 8;

function clampRect(r: Rect, vw: number, vh: number): Rect {
  const left = Math.max(0, Math.min(r.left, vw - 1));
  const top = Math.max(0, Math.min(r.top, vh - 1));
  return {
    left,
    top,
    width: Math.max(1, Math.min(r.width, vw - left)),
    height: Math.max(1, Math.min(r.height, vh - top)),
  };
}

function normalize(l: number, t: number, r: number, b: number): Rect {
  return {
    left: Math.min(l, r),
    top: Math.min(t, b),
    width: Math.abs(r - l),
    height: Math.abs(b - t),
  };
}

function Overlay({ monitorId }: { monitorId: number }) {
  const [info, setInfo] = useState<OverlayInfo | null>(null);
  const [phase, setPhase] = useState<Phase>("pick");
  const [rect, setRect] = useState<Rect | null>(null);
  const [hover, setHover] = useState<{ rect: Rect; title: string } | null>(null);
  // ルーペ用のカーソル位置（CSS px、矩形モードのみ追跡） / Cursor for the loupe (CSS px, region mode only)
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const frameImgRef = useRef<HTMLImageElement | null>(null);
  const loupeRef = useRef<HTMLCanvasElement | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const submitting = useRef(false);
  // ダブルクリック判定用：直近のpointerdown時刻（ms） / Last pointerdown time for double-click detection
  const lastDownTime = useRef(0);

  // rAFスロットリング：mousemove毎ではなく描画フレーム毎に1回だけ反映する
  // rAF throttling: apply at most one update per animation frame, not per mousemove
  const rafId = useRef(0);
  const pendingUpdate = useRef<(() => void) | null>(null);
  const schedule = useCallback((fn: () => void) => {
    pendingUpdate.current = fn;
    if (!rafId.current) {
      rafId.current = requestAnimationFrame(() => {
        rafId.current = 0;
        const fn = pendingUpdate.current;
        pendingUpdate.current = null;
        fn?.();
      });
    }
  }, []);

  // 凍結画像のバージョン：セッション毎に更新してimgを再取得させる（0 = 非表示）
  // Frozen frame version: bumped per session to force an img refetch (0 = no frame shown)
  const [imgVersion, setImgVersion] = useState(0);

  const resetState = useCallback(() => {
    gesture.current = null;
    submitting.current = false;
    setRect(null);
    setHover(null);
    setCursor(null);
    setPhase("pick");
  }, []);

  // このウィンドウは常駐・使い回しのため、セッションイベントで状態を切り替える
  // This window is resident & reused, so state transitions are driven by session events
  useEffect(() => {
    const win = getCurrentWebviewWindow();
    const load = () =>
      invoke<OverlayInfo | null>("get_overlay_info", { monitorId })
        .then((fresh) => {
          setInfo(fresh);
          if (fresh) {
            setImgVersion(Date.now());
            // ずれ診断：ウィンドウ実寸（物理px換算）と凍結画像実寸の不一致を検出する
            // Misalignment diagnostics: window size in physical px vs the frozen frame size
            const dpr = window.devicePixelRatio;
            invoke("frontend_log", {
              message:
                `overlay ${monitorId}: win ${window.innerWidth}x${window.innerHeight} @dpr=${dpr} ` +
                `= ${Math.round(window.innerWidth * dpr)}x${Math.round(window.innerHeight * dpr)}px, ` +
                `frame ${fresh.width}x${fresh.height}px, screen(${window.screenX},${window.screenY})`,
            });
          }
        })
        .catch((e) => invoke("frontend_log", { message: `get_overlay_info failed: ${e}` }));

    const unlistenStart = win.listen("session-start", () => {
      invoke("frontend_log", { message: `overlay ${monitorId}: session-start received` });
      resetState();
      load();
    });
    const unlistenEnd = win.listen("session-end", () => {
      resetState();
      setImgVersion(0); // 古い凍結画像を解放 / Release the old frozen frame
    });
    load(); // 生成直後にセッションが既に始まっている場合に備える / In case a session is already active

    return () => {
      unlistenStart.then((f) => f());
      unlistenEnd.then((f) => f());
    };
  }, [monitorId, resetState]);

  const confirm = useCallback(
    async (target?: Rect) => {
      const r = target ?? rect;
      if (!r || submitting.current) return;
      submitting.current = true;
      const dpr = window.devicePixelRatio;
      await invoke("finish_region_capture", {
        monitorId,
        x: Math.max(0, Math.round(r.left * dpr)),
        y: Math.max(0, Math.round(r.top * dpr)),
        width: Math.max(1, Math.round(r.width * dpr)),
        height: Math.max(1, Math.round(r.height * dpr)),
      }).catch((e) => invoke("frontend_log", { message: `finish failed: ${e}` }));
    },
    [rect, monitorId],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Escでセッション全体を中断（全モニターのオーバーレイが閉じる）
      // Esc cancels the whole session (closes overlays on all monitors)
      if (e.key === "Escape") invoke("cancel_capture");
      if (e.key === "Enter" && phase === "adjust") confirm();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, confirm]);

  useEffect(() => {
    const onError = (e: ErrorEvent) =>
      invoke("frontend_log", { message: `overlay error: ${e.message}` });
    window.addEventListener("error", onError);
    return () => window.removeEventListener("error", onError);
  }, []);

  // ウィンドウ候補のヒットテスト（最前面が先頭で並んでいる）
  // Hit-test pickable windows (array is ordered topmost first)
  const hitTestWindow = useCallback(
    (cssX: number, cssY: number): { rect: Rect; title: string } | null => {
      if (!info) return null;
      const dpr = window.devicePixelRatio;
      const px = cssX * dpr;
      const py = cssY * dpr;
      for (const w of info.windows) {
        if (px >= w.x && px < w.x + w.width && py >= w.y && py < w.y + w.height) {
          return {
            rect: clampRect(
              { left: w.x / dpr, top: w.y / dpr, width: w.width / dpr, height: w.height / dpr },
              window.innerWidth,
              window.innerHeight,
            ),
            title: w.title,
          };
        }
      }
      return null;
    },
    [info],
  );

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || !info) return;
    const target = e.target as HTMLElement;
    const handle = target.dataset.handle as Handle | undefined;

    if (phase === "adjust" && rect) {
      if (handle) {
        gesture.current = { kind: "resize", handle, ax: e.clientX, ay: e.clientY, start: rect };
      } else if (target.dataset.role === "selection") {
        // 選択範囲内のダブルクリックで確定（ポインタ捕捉でdblclickが届かないため自前判定）
        // Double-click inside the selection confirms (manual detection; pointer capture eats dblclick)
        if (e.timeStamp - lastDownTime.current < 350) {
          lastDownTime.current = 0;
          confirm();
          return;
        }
        lastDownTime.current = e.timeStamp;
        gesture.current = { kind: "move", ox: e.clientX - rect.left, oy: e.clientY - rect.top, start: rect };
      } else {
        return; // 選択範囲外のクリックは無視 / Ignore clicks outside the selection
      }
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      return;
    }

    if (phase === "pick") {
      if (info.mode === "window") {
        const hit = hitTestWindow(e.clientX, e.clientY);
        if (hit) {
          setRect(hit.rect);
          setHover(null);
          setPhase("adjust");
        }
        return;
      }
      gesture.current = { kind: "draw", ax: e.clientX, ay: e.clientY };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      setPhase("drag");
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!info) return;
    const { clientX: cx, clientY: cy } = e;

    if (phase === "pick" && info.mode === "window") {
      schedule(() => setHover(hitTestWindow(cx, cy)));
      return;
    }
    const g = gesture.current;
    // ルーペ用のカーソル追跡：矩形モード中、または調整モードでの枠変更・移動中
    // Track the cursor for the loupe: region mode, or while resizing/moving in adjust mode
    const trackCursor =
      (info.mode === "region" && (phase === "pick" || phase === "drag")) ||
      (phase === "adjust" && g !== null && (g.kind === "move" || g.kind === "resize"));
    if (!g && !trackCursor) return;

    schedule(() => {
      if (trackCursor) setCursor({ x: cx, y: cy });
      if (!g) return;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      if (g.kind === "draw") {
        setRect(normalize(g.ax, g.ay, cx, cy));
      } else if (g.kind === "move") {
        const left = Math.max(0, Math.min(cx - g.ox, vw - g.start.width));
        const top = Math.max(0, Math.min(cy - g.oy, vh - g.start.height));
        setRect({ ...g.start, left, top });
      } else {
        const dx = cx - g.ax;
        const dy = cy - g.ay;
        let l = g.start.left;
        let t = g.start.top;
        let r = g.start.left + g.start.width;
        let b = g.start.top + g.start.height;
        if (g.handle.includes("w")) l += dx;
        if (g.handle.includes("e")) r += dx;
        if (g.handle.includes("n")) t += dy;
        if (g.handle.includes("s")) b += dy;
        setRect(clampRect(normalize(l, t, r, b), vw, vh));
      }
    });
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const g = gesture.current;
    gesture.current = null;
    if (phase === "drag") {
      const dpr = window.devicePixelRatio;
      // 最終矩形はrAF反映待ちのrectではなくポインタ座標から直接計算する（1フレームの取りこぼし防止）
      // Compute the final rect from the pointer itself, not the rAF-delayed state (no lost frame)
      const final =
        g?.kind === "draw"
          ? clampRect(normalize(g.ax, g.ay, e.clientX, e.clientY), window.innerWidth, window.innerHeight)
          : rect;
      if (!final || final.width * dpr < MIN_SELECTION_PX || final.height * dpr < MIN_SELECTION_PX) {
        setRect(null);
        setPhase("pick");
      } else {
        // ドロップ後は調整フェーズへ。Wクリック/✓/Enterで確定する（即キャプチャはしない）
        // After drop, enter adjust phase; confirm via double-click / ✓ / Enter (no instant capture)
        setRect(final);
        setPhase("adjust");
        setCursor(null);
      }
    } else if (g && (g.kind === "move" || g.kind === "resize")) {
      // 調整継続。ルーペは操作中のみ表示するため消す / Stay in adjust; hide the loupe (shown only mid-gesture)
      setCursor(null);
    }
  };

  // ルーペ描画：カーソル周辺の物理ピクセルを等倍セルで拡大表示する
  // Draw the loupe: magnify the physical pixels around the cursor
  useEffect(() => {
    const canvas = loupeRef.current;
    const img = frameImgRef.current;
    if (!canvas || !img || !cursor) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio;
    const src = LOUPE_SIZE / LOUPE_ZOOM; // 取り込む元領域（物理px） / Source region (physical px)
    const px = Math.floor(cursor.x * dpr);
    const py = Math.floor(cursor.y * dpr);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = "#18181b";
    ctx.fillRect(0, 0, LOUPE_SIZE, LOUPE_SIZE);
    ctx.drawImage(img, px - src / 2, py - src / 2, src, src, 0, 0, LOUPE_SIZE, LOUPE_SIZE);
    // 十字線はカーソルピクセルの中心を通す / Crosshair through the cursor pixel's center
    const c = LOUPE_SIZE / 2;
    const m = c + LOUPE_ZOOM / 2;
    ctx.strokeStyle = "rgba(251, 191, 36, 0.55)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(m, 0);
    ctx.lineTo(m, LOUPE_SIZE);
    ctx.moveTo(0, m);
    ctx.lineTo(LOUPE_SIZE, m);
    ctx.stroke();
    // 中心ピクセルのセルを強調 / Highlight the cursor pixel cell
    ctx.strokeStyle = "#fbbf24";
    ctx.strokeRect(c + 0.5, c + 0.5, LOUPE_ZOOM - 1, LOUPE_ZOOM - 1);
  }, [cursor]);

  if (!info) {
    return <div className="h-screen w-screen bg-black/40" />;
  }

  const dpr = window.devicePixelRatio;
  const active = rect ?? hover?.rect ?? null;
  const cursorClass =
    phase === "pick" ? (info.mode === "window" ? "cursor-pointer" : "cursor-crosshair") : "";
  // ツールバーは矩形の下、入らなければ上に出す / Toolbar goes below the rect, or above if no room
  const toolbarBelow = rect ? rect.top + rect.height + 44 < window.innerHeight : true;

  return (
    <div
      className={`relative h-screen w-screen select-none overflow-hidden ${cursorClass}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      {/* 凍結フレーム（無圧縮BMPをメモリから直接配信） / Frozen frame (uncompressed BMP served from memory) */}
      {imgVersion > 0 && (
        <img
          ref={frameImgRef}
          src={`http://freeze.localhost/${monitorId}?v=${imgVersion}`}
          className="absolute inset-0 h-full w-full"
          draggable={false}
          alt=""
          onLoad={() => {
            invoke("frontend_log", { message: `overlay ${monitorId}: frame loaded` });
            // 画像が描画できる状態になったら即ウィンドウを表示する（フェードなし＝最速）
            // Show the window immediately once the frame can paint (no fade = fastest)
            invoke("overlay_ready", { monitorId });
          }}
          onError={() =>
            invoke("frontend_log", { message: `frozen frame failed to load: monitor ${monitorId}` })
          }
        />
      )}

      {active ? (
        <div
          data-role="selection"
          className={`absolute border-[3px] border-amber-400 ${phase === "adjust" ? "cursor-move" : ""}`}
          style={{
            left: active.left,
            top: active.top,
            width: active.width,
            height: active.height,
            // 外側を暗くする：巨大スパンのbox-shadow（再描画が軽く高速）
            // Dim the outside via a huge-spread box-shadow (cheap to repaint, fast)
            boxShadow: "0 0 0 100000px rgba(0, 0, 0, 0.35)",
          }}
        >
          {/* サイズ表示 / Size badge */}
          <span className="pointer-events-none absolute -top-6 left-0 rounded bg-zinc-900/90 px-1.5 py-0.5 font-mono text-xs text-amber-300">
            {Math.round(active.width * dpr)} × {Math.round(active.height * dpr)}
            {phase === "pick" && hover ? ` — ${hover.title}` : ""}
          </span>

          {phase === "adjust" && (
            <>
              {/* 8方向リサイズハンドル / 8-direction resize handles */}
              {HANDLES.map((h) => (
                <div
                  key={h}
                  data-handle={h}
                  className="absolute h-2.5 w-2.5 rounded-sm border border-zinc-900 bg-amber-400"
                  style={{
                    cursor: HANDLE_CURSOR[h],
                    left: h.includes("w") ? -5 : h.includes("e") ? undefined : "calc(50% - 5px)",
                    right: h.includes("e") ? -5 : undefined,
                    top: h.includes("n") ? -5 : h.includes("s") ? undefined : "calc(50% - 5px)",
                    bottom: h.includes("s") ? -5 : undefined,
                  }}
                />
              ))}

              {/* 確定/キャンセル / Confirm & cancel */}
              <div
                className="absolute flex gap-1.5"
                style={
                  toolbarBelow
                    ? { top: "100%", right: 0, marginTop: 8 }
                    : { bottom: "100%", right: 0, marginBottom: 8 }
                }
                onPointerDown={(e) => e.stopPropagation()}
              >
                <button
                  onClick={() => confirm()}
                  className="rounded-lg bg-amber-400 px-3 py-1.5 text-sm font-bold text-zinc-900 shadow hover:bg-amber-300"
                  title="キャプチャ (Enter)"
                >
                  ✓
                </button>
                <button
                  onClick={() => invoke("cancel_capture")}
                  className="rounded-lg bg-zinc-800 px-3 py-1.5 text-sm font-bold text-zinc-300 shadow hover:bg-zinc-700"
                  title="キャンセル (Esc)"
                >
                  ✕
                </button>
              </div>
            </>
          )}
        </div>
      ) : (
        <div className="pointer-events-none absolute inset-0 bg-black/35" />
      )}

      {/* ルーペ：矩形モード中と、調整モードの枠変更・移動中に表示（1px単位の調整用） */}
      {/* Loupe: shown in region mode and while adjusting the frame, for 1px-precision aiming */}
      {cursor && imgVersion > 0 && (
        <div
          className="pointer-events-none absolute z-50"
          style={{
            // デフォルトはカーソルの左下。画面端では右・上へ回り込む
            // Defaults to the cursor's lower-left; flips right/up near screen edges
            left:
              cursor.x - 24 - LOUPE_SIZE < 0
                ? cursor.x + 24
                : cursor.x - 24 - LOUPE_SIZE,
            top:
              cursor.y + 24 + LOUPE_SIZE + 28 > window.innerHeight
                ? cursor.y - 24 - LOUPE_SIZE - 28
                : cursor.y + 24,
          }}
        >
          <canvas
            ref={loupeRef}
            width={LOUPE_SIZE}
            height={LOUPE_SIZE}
            className="block rounded-lg border-2 border-amber-400 shadow-lg"
          />
          <div className="mt-1 rounded bg-zinc-900/90 px-1.5 py-0.5 text-center font-mono text-xs text-amber-300">
            {(phase === "drag" || phase === "adjust") && rect
              ? `${Math.round(rect.width * dpr)} × ${Math.round(rect.height * dpr)}`
              : `${Math.floor(cursor.x * dpr)}, ${Math.floor(cursor.y * dpr)}`}
          </div>
        </div>
      )}
    </div>
  );
}

export default Overlay;
