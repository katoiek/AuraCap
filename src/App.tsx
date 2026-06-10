import Home from "./Home";
import Overlay from "./Overlay";

// URLクエリでウィンドウの役割を切り替える / Window role is selected via URL query
// ?overlay=<monitorId> → 領域選択オーバーレイ / region-selection overlay
function App() {
  const params = new URLSearchParams(window.location.search);
  const overlayId = params.get("overlay");
  if (overlayId !== null) {
    return <Overlay monitorId={Number(overlayId)} />;
  }
  return <Home />;
}

export default App;
