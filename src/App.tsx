import Editor from "./Editor";
import Home from "./Home";
import Overlay from "./Overlay";
import Pin from "./Pin";

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
  const pinId = params.get("pin");
  if (pinId !== null) {
    return <Pin id={Number(pinId)} />;
  }
  // ?recframe=1 → 録画中の黄色枠バー（中身は単色、窓の背景色で表示）/ Recording frame bar (solid color)
  if (params.get("recframe") !== null) {
    return <div style={{ width: "100%", height: "100%", background: "#facc15" }} />;
  }
  return <Home />;
}

export default App;
