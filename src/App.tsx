import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import Editor from "./Editor";
import Home from "./Home";
import Overlay from "./Overlay";
import Pin from "./Pin";
import VideoEditor from "./VideoEditor";

// 録画中の枠バー：不透明窓を選択矩形の外側に4本並べる。中身はテーマ色の単色div。
// Recording frame bar: an opaque window placed just outside the rect; content is a solid themed div.
function RecFrame() {
  useEffect(() => {
    const root = document.getElementById("root");
    // 表示される度に最新テーマを反映（窓は常駐・使い回しのため）
    // Re-apply the latest theme whenever shown (the window is resident & reused)
    const applyTheme = () =>
      root?.setAttribute("data-theme", localStorage.getItem("auracap_theme") || "graphite");
    applyTheme();
    const onVis = () => {
      if (document.visibilityState === "visible") applyTheme();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);
  return <div style={{ width: "100%", height: "100%", background: "var(--accent)" }} />;
}

// 録画開始までのカウントダウン：選択枠の中央に残り秒数を出す。
// 秒の刻みはここで進める（バックエンドは開始の合図を1回送るだけ）。
// 配色はテーマに依存させない：不透明なダークの円＋白文字にして、明るい画面でも
// 暗い画面でも必ず読めるようにする。アクセント色はリングだけに使う。
// Countdown before recording starts, shown at the center of the selected frame. The ticking runs
// here; the backend only sends a single start signal. The colors deliberately don't follow the
// theme — an opaque dark disc with white digits stays readable over any content — and the accent
// color is used only for the ring.
const COUNTDOWN_FONT = '"Segoe UI", system-ui, sans-serif';

// 数字の「インク（実際に描かれる範囲）」の中心を、行ボックスの中心へ合わせるための補正量（em単位）。
// フォントの行ボックス（ascent/descent）と数字の字形は中心が一致しないため、そのまま中央寄せすると
// 数字が下や左右へずれて見える。canvasで実測して打ち消す。
// Correction (in em) that moves the digit's ink center onto the line box's center. A font's line box
// (ascent/descent) and its digit glyphs don't share a center, so plain centering looks off; measure
// with canvas and cancel the difference.
let inkCtx: CanvasRenderingContext2D | null = null;
function inkOffset(text: string): { x: number; y: number } {
  if (!inkCtx) inkCtx = document.createElement("canvas").getContext("2d");
  const ctx = inkCtx;
  if (!ctx || !text) return { x: 0, y: 0 };
  const px = 100;
  ctx.font = `700 ${px}px ${COUNTDOWN_FONT}`;
  const m = ctx.measureText(text);
  // 古い環境でfontBoundingBox*が無ければ縦の補正は諦める / Skip the vertical fix if fontBoundingBox* is unavailable
  const fa = m.fontBoundingBoxAscent;
  const fd = m.fontBoundingBoxDescent;
  const y = fa === undefined || fd === undefined
    ? 0
    : -((fa - fd) - (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent)) / 2 / px;
  const x = -((m.actualBoundingBoxRight - m.actualBoundingBoxLeft) - m.width) / 2 / px;
  return { x, y };
}

function Countdown() {
  const [remaining, setRemaining] = useState<number | null>(null);
  useEffect(() => {
    const root = document.getElementById("root");
    // 表示される度に最新テーマを反映（窓は常駐・使い回しのため）
    // Re-apply the latest theme whenever shown (the window is resident & reused)
    const applyTheme = () =>
      root?.setAttribute("data-theme", localStorage.getItem("auracap_theme") || "graphite");
    applyTheme();
    const onVis = () => {
      if (document.visibilityState === "visible") applyTheme();
    };
    document.addEventListener("visibilitychange", onVis);

    // 透過窓：背景を消して下のデスクトップを透かす（バッジだけを丸く見せる）
    // Transparent window: clear backgrounds so only the round badge is visible
    const html = document.documentElement;
    const body = document.body;
    html.style.background = "transparent";
    body.style.background = "transparent";
    if (root) root.style.background = "transparent";

    let timer: number | undefined;
    const unlisten = getCurrentWebviewWindow().listen<number>("countdown-start", (e) => {
      invoke("frontend_log", { message: `countdown: start ${e.payload}s` });
      window.clearInterval(timer);
      setRemaining(e.payload);
      timer = window.setInterval(() => {
        setRemaining((n) => (n !== null && n > 1 ? n - 1 : n));
      }, 1000);
    });
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.clearInterval(timer);
      unlisten.then((f) => f());
    };
  }, []);

  const off = inkOffset(remaining === null ? "" : String(remaining));

  return (
    <div
      style={{
        width: "100vw",
        height: "100vh",
        display: "grid",
        placeItems: "center",
        borderRadius: "50%",
        background: "rgba(24, 24, 27, 0.92)",
        // borderだとボックスサイズに影響するのでinset shadowでリングを描く
        // An inset shadow draws the ring without affecting the box size
        boxShadow: "inset 0 0 0 max(3px, 3vmin) var(--accent)",
        color: "#ffffff",
        fontFamily: COUNTDOWN_FONT,
        fontWeight: 700,
        fontSize: "50vmin",
        lineHeight: 1,
        position: "relative",
      }}
    >
      {/* 数字ごとにインク中心を実測して補正する（tabular-numsは使わず、各桁を個別に中央へ） */}
      {/* Correct per digit by measured ink center (no tabular-nums; each value is centered on its own) */}
      <span style={{ display: "block", transform: `translate(${off.x}em, ${off.y}em)` }}>
        {remaining ?? ""}
      </span>
      {/* 中止の案内。数字の下に小さく添える / Small cancel hint under the digit */}
      {remaining !== null && (
        <span
          style={{
            position: "absolute",
            bottom: "16%",
            fontSize: "9vmin",
            fontWeight: 600,
            opacity: 0.75,
            letterSpacing: "0.05em",
          }}
        >
          Esc で中止
        </span>
      )}
    </div>
  );
}

// URLクエリでウィンドウの役割を切り替える / Window role is selected via URL query
// ?overlay=<monitorId> → 領域選択オーバーレイ / region-selection overlay
// ?editor=1 → 軽量エディタ / quick editor
// ?pin=<id> → 付箋ピン留め / pinned floating image
function App() {
  const params = new URLSearchParams(window.location.search);
  const overlayId = params.get("overlay");
  if (overlayId !== null) {
    return <Overlay monitorId={Number(overlayId)} />;
  }
  if (params.get("editor") !== null) {
    return <Editor />;
  }
  if (params.get("video") !== null) {
    return <VideoEditor />;
  }
  const pinId = params.get("pin");
  if (pinId !== null) {
    return <Pin id={Number(pinId)} />;
  }
  // ?recframe=1 → 録画中の枠（透明窓＋テーマ色ボーダー）/ Recording frame (transparent window + themed border)
  if (params.get("recframe") !== null) {
    return <RecFrame />;
  }
  // ?countdown=1 → 録画開始までのカウントダウン / Countdown before recording starts
  if (params.get("countdown") !== null) {
    return <Countdown />;
  }
  return <Home />;
}

export default App;
