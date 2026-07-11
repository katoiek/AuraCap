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
// ルーペのサイズと倍率：元画像1pxを8pxのセルで表示。取得ピクセル数は必ず奇数にして
// カーソルのピクセルをルーペの中央セルにぴったり置く（十字線が中心からずれるのを防ぐ）
// Loupe size & zoom: each source pixel shows as an 8px cell. LOUPE_SRC must be ODD so the
// cursor pixel lands exactly in the center cell (keeps the crosshair dead-center).
const LOUPE_ZOOM = 8;
const LOUPE_SRC = 17;
const LOUPE_SIZE = LOUPE_SRC * LOUPE_ZOOM; // 136

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
  // ルーペ用のカーソル位置（CSS px） / Cursor position for the loupe (CSS px)
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const loupeRef = useRef<HTMLCanvasElement | null>(null);
  // ルーペ用のオフスクリーンバッファ（サーバから届く生ピクセルの受け皿） / Offscreen buffer for the raw pixels from the backend
  const loupeBufRef = useRef<HTMLCanvasElement | null>(null);
  if (!loupeBufRef.current) {
    const c = document.createElement("canvas");
    c.width = LOUPE_SRC;
    c.height = LOUPE_SRC;
    loupeBufRef.current = c;
  }
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

  const resetState = useCallback(() => {
    gesture.current = null;
    submitting.current = false;
    setRect(null);
    setHover(null);
    setCursor(null);
    setPhase("pick");
  }, []);

  // 透明窓：背景を透過させ、下の実デスクトップを見せる（SnippingやNexusと同方式・高速）
  // Transparent window: clear backgrounds so the live desktop shows through (fast, like Snipping/Nexus)
  useEffect(() => {
    const html = document.documentElement;
    const body = document.body;
    const root = document.getElementById("root");
    const prev = [html.style.background, body.style.background, root?.style.background ?? ""];
    html.style.background = "transparent";
    body.style.background = "transparent";
    if (root) root.style.background = "transparent";
    return () => {
      html.style.background = prev[0];
      body.style.background = prev[1];
      if (root) root.style.background = prev[2];
    };
  }, []);

  // このウィンドウは常駐・使い回しのため、セッションイベントで状態を切り替える
  // This window is resident & reused, so state transitions are driven by session events
  useEffect(() => {
    const win = getCurrentWebviewWindow();
    const load = () => {
      // セッション毎に最新テーマを再適用（選択枠のアクセント色をテーマに合わせる）
      // Re-apply the current theme each session so the selection accent matches
      const t = localStorage.getItem("auracap_theme") || "graphite";
      document.getElementById("root")?.setAttribute("data-theme", t);
      return invoke<OverlayInfo | null>("get_overlay_info", { monitorId })
        .then((fresh) => {
          setInfo(fresh);
          if (fresh) {
            // 凍結画像を待たず、情報が揃った時点で即ウィンドウを表示する（透明窓＝最速）
            // No frozen frame to wait for; show the window as soon as info is ready (transparent = fastest)
            invoke("overlay_ready", { monitorId });
          }
        })
        .catch((e) => invoke("frontend_log", { message: `get_overlay_info failed: ${e}` }));
    };

    const unlistenStart = win.listen("session-start", () => {
      resetState();
      load();
    });
    const unlistenEnd = win.listen("session-end", () => {
      resetState();
      setInfo(null);
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

  // ルーペ描画：バックエンドからカーソル周辺の生ピクセルだけ取得し、拡大して表示する
  // （凍結画像全体をWebViewに読み込まないため、透明窓方式の速度を保ったまま実現する）
  // Draw the loupe: fetch only the raw pixels around the cursor from the backend and magnify
  // them (keeps the transparent-window approach fast — no full frozen frame loads into the WebView)
  useEffect(() => {
    const canvas = loupeRef.current;
    const buf = loupeBufRef.current;
    if (!canvas || !buf || !cursor) return;
    const ctx = canvas.getContext("2d");
    const bufCtx = buf.getContext("2d");
    if (!ctx || !bufCtx) return;
    let cancelled = false;
    const dpr = window.devicePixelRatio;
    const px = Math.floor(cursor.x * dpr);
    const py = Math.floor(cursor.y * dpr);

    fetch(`http://loupe.localhost/${monitorId}?x=${px}&y=${py}&size=${LOUPE_SRC}`)
      .then((res) => (res.ok ? res.arrayBuffer() : null))
      .then((buffer) => {
        if (cancelled || !buffer) return;
        bufCtx.putImageData(new ImageData(new Uint8ClampedArray(buffer), LOUPE_SRC, LOUPE_SRC), 0, 0);

        ctx.imageSmoothingEnabled = false;
        ctx.fillStyle = "#18181b";
        ctx.fillRect(0, 0, LOUPE_SIZE, LOUPE_SIZE);
        ctx.drawImage(buf, 0, 0, LOUPE_SRC, LOUPE_SRC, 0, 0, LOUPE_SIZE, LOUPE_SIZE);

        // 元画像の1pxごとに薄いグリッド線を引く（拡大セルの境界を可視化） / Faint grid line per source pixel (marks each magnified cell's edge)
        ctx.strokeStyle = "rgba(255, 255, 255, 0.12)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let i = 1; i < LOUPE_SRC; i++) {
          const p = i * LOUPE_ZOOM + 0.5;
          ctx.moveTo(p, 0);
          ctx.lineTo(p, LOUPE_SIZE);
          ctx.moveTo(0, p);
          ctx.lineTo(LOUPE_SIZE, p);
        }
        ctx.stroke();

        // 十字線はカーソルピクセルのセル中心を通す（backendの切り出しと同じく half=size/2）
        // Crosshair through the center of the cursor pixel's cell (matches backend crop: half=size/2)
        const accent =
          getComputedStyle(document.getElementById("root") ?? document.documentElement)
            .getPropertyValue("--accent")
            .trim() || "#22d3ee";
        const cellStart = Math.floor(LOUPE_SRC / 2) * LOUPE_ZOOM; // カーソルピクセルのセル左上 / top-left of cursor cell
        const m = cellStart + LOUPE_ZOOM / 2; // セル中心＝奇数SRCならルーペ中心 / cell center (= loupe center for odd SRC)
        ctx.strokeStyle = `${accent}8c`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(m, 0);
        ctx.lineTo(m, LOUPE_SIZE);
        ctx.moveTo(0, m);
        ctx.lineTo(LOUPE_SIZE, m);
        ctx.stroke();
        // カーソルピクセルのセルを強調 / Highlight the cursor pixel cell
        ctx.strokeStyle = accent;
        ctx.strokeRect(cellStart + 0.5, cellStart + 0.5, LOUPE_ZOOM - 1, LOUPE_ZOOM - 1);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [cursor, monitorId]);

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
    // ルーペ用のカーソル追跡：矩形モード中（描画前後）、または調整モードでの枠変更・移動中
    // Track the cursor for the loupe: region mode (before/while drawing), or while resizing/moving in adjust mode
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
      // ドロップした瞬間にルーペは消す（次に表示するのは調整モードの枠変更・移動中のみ）
      // Hide the loupe the moment the drag ends (it reappears only while resizing/moving in adjust mode)
      setCursor(null);
      if (!final || final.width * dpr < MIN_SELECTION_PX || final.height * dpr < MIN_SELECTION_PX) {
        setRect(null);
        setPhase("pick");
      } else {
        // ドロップ後は調整フェーズへ。Wクリック/✓/Enterで確定する（即キャプチャはしない）
        // After drop, enter adjust phase; confirm via double-click / ✓ / Enter (no instant capture)
        setRect(final);
        setPhase("adjust");
      }
    } else if (g && (g.kind === "move" || g.kind === "resize")) {
      // 調整継続。ルーペは操作中のみ表示するため消す / Stay in adjust; hide the loupe (shown only mid-gesture)
      setCursor(null);
    }
  };

  if (!info) {
    // 透明のまま（凍結画像を待たない）/ Stay transparent (no frozen frame to wait for)
    return <div className="h-screen w-screen" />;
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
      {/* 暗転：全面を薄暗くし、選択部だけSVGマスクでくり抜く（下の重い画像が無いので軽い）
          Dim: darken everything and cut out the selection via an SVG mask (light; no heavy image beneath) */}
      <svg className="pointer-events-none absolute inset-0 h-full w-full">
        <defs>
          <mask id="selection-mask">
            <rect x="0" y="0" width="100%" height="100%" fill="white" />
            {active && (
              <rect
                x={active.left}
                y={active.top}
                width={active.width}
                height={active.height}
                fill="black"
              />
            )}
          </mask>
        </defs>
        <rect
          x="0"
          y="0"
          width="100%"
          height="100%"
          fill="rgba(0, 0, 0, 0.35)"
          mask="url(#selection-mask)"
        />
      </svg>

      {/* X/Y軸ガイド線：カーソル位置を中心に画面全体へ伸ばし、周囲のUIとの位置合わせを助ける */}
      {/* X/Y axis guides: full-screen lines through the cursor, for aligning against surrounding UI */}
      {cursor && (
        <>
          <div
            className="pointer-events-none absolute inset-x-0 h-px bg-[var(--accent)]/50"
            style={{ top: cursor.y }}
          />
          <div
            className="pointer-events-none absolute inset-y-0 w-px bg-[var(--accent)]/50"
            style={{ left: cursor.x }}
          />
        </>
      )}

      {active && (
        <div
          data-role="selection"
          className={`absolute border-[3px] border-[var(--accent)] ${phase === "adjust" ? "cursor-move" : ""}`}
          style={{
            left: active.left,
            top: active.top,
            width: active.width,
            height: active.height,
          }}
        >
          {/* サイズ表示 / Size badge */}
          <span className="pointer-events-none absolute -top-6 left-0 rounded bg-zinc-900/90 px-1.5 py-0.5 font-mono text-xs text-[var(--accent)]">
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
                  className="absolute h-2.5 w-2.5 rounded-sm border border-zinc-900 bg-[var(--accent)]"
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
                  className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-sm font-bold text-zinc-900 shadow hover:bg-[var(--accent-strong)]"
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
      )}

      {/* ルーペ：矩形選択中と、調整モードの枠変更・移動中に表示（1px単位の調整用） */}
      {/* Loupe: shown while selecting a rectangle, and while resizing/moving in adjust mode (for 1px-precision aiming) */}
      {cursor && (
        <div
          className="pointer-events-none absolute z-50"
          style={{
            // デフォルトはカーソルの左下。画面端では右・上へ回り込む
            // Defaults to the cursor's lower-left; flips right/up near screen edges
            left: cursor.x - 24 - LOUPE_SIZE < 0 ? cursor.x + 24 : cursor.x - 24 - LOUPE_SIZE,
            top:
              cursor.y + 24 + LOUPE_SIZE + 28 > window.innerHeight
                ? cursor.y - 24 - LOUPE_SIZE - 28
                : cursor.y + 24,
          }}
        >
          {/* TechSmith Capture風に円形。クリップは外側divのoverflow-hiddenで行う（canvas自体は正方形のまま） */}
          {/* Circular like TechSmith Capture; clipping comes from the outer div's overflow-hidden (canvas itself stays square) */}
          <div
            className="overflow-hidden rounded-full border-2 border-[var(--accent)] shadow-lg"
            style={{ width: LOUPE_SIZE, height: LOUPE_SIZE }}
          >
            <canvas ref={loupeRef} width={LOUPE_SIZE} height={LOUPE_SIZE} className="block" />
          </div>
          <div className="mt-1 rounded bg-zinc-900/90 px-1.5 py-0.5 text-center font-mono text-xs text-[var(--accent)]">
            {rect && (phase === "drag" || phase === "adjust")
              ? `${Math.round(rect.width * dpr)} × ${Math.round(rect.height * dpr)}`
              : `${Math.floor(cursor.x * dpr)}, ${Math.floor(cursor.y * dpr)}`}
          </div>
        </div>
      )}
    </div>
  );
}

export default Overlay;
