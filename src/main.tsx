import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

// 全ウィンドウで初回描画前にテーマを適用（アクセント色を全窓で一致させる）。
// グラデ背景はメインのみ表示され、他窓は自前の背景/透過で隠れる。
// Apply the saved theme before first paint on every window so the accent color matches.
// Only the main window shows the gradient; others hide it via their own/transparent background.
{
  const theme = localStorage.getItem("auracap_theme") || "graphite";
  document.getElementById("root")?.setAttribute("data-theme", theme);
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
