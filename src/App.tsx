import { useEffect } from "react";
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
  return <Home />;
}

export default App;
