import type { Tool } from "./model";

// ツールバー用のSVGアイコン（reicon風のクリーンなライン。currentColorで選択状態に追従）
// Toolbar SVG icons (clean reicon-style linework; currentColor follows active/inactive state)
function ToolIcon({ tool }: { tool: Tool }) {
  const p = {
    width: 20,
    height: 20,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  switch (tool) {
    case "select": // マウスカーソル（矢印ツールと明確に区別）/ Mouse cursor, clearly distinct from the arrow tool
      return (
        <svg {...p}>
          <path d="M4 3l7 16 2.3-6.7L20 10z" fill="currentColor" />
          <path d="M13 13l5 6" />
        </svg>
      );
    case "rect": // 矩形枠 / Rectangle frame
      return (
        <svg {...p}>
          <rect x="4" y="5" width="16" height="14" rx="2" />
        </svg>
      );
    case "arrow": // 直線＋塗りの矢じり（実際に描画される矢印と揃える）/ Line + filled arrowhead matching the drawn arrow
      return (
        <svg {...p}>
          <line x1="4" y1="20" x2="15" y2="9" />
          <path d="M20 4l-3 8-5-3z" fill="currentColor" />
        </svg>
      );
    case "text": // テキスト（以前の文字グリフに戻す）/ Text (restored to the original glyph)
      return <span className="text-base leading-none">T</span>;
    case "highlight": // ハイライト（以前の文字グリフに戻す）/ Highlight (restored to the original glyph)
      return <span className="text-base leading-none">▆</span>;
    case "blur": // ぼかし（以前の文字グリフに戻す）/ Blur (restored to the original glyph)
      return <span className="text-base leading-none">▒</span>;
    case "badge": // 番号バッジ（丸に1）/ Numbered badge (circle with "1")
      return (
        <svg {...p}>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M11 9.5l1.6-1v7" strokeWidth="1.8" />
        </svg>
      );
    case "crop": // トリミング / Crop
      return (
        <svg {...p}>
          <path d="M6 2v14a2 2 0 0 0 2 2h14" />
          <path d="M18 22V8a2 2 0 0 0-2-2H2" />
        </svg>
      );
  }
}

export default ToolIcon;
