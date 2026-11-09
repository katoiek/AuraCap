// 軽量エディタのドメインモデル：アノテーションの型・定数・純粋な計測ヘルパー。
// UIにもPNG書き出しにも共通で使うため、Reactに依存しないここへ集約する。
// Quick-editor domain model: annotation types, constants, and pure measurement helpers.
// Shared by the UI and the PNG export, so this module stays free of React.

export type Tool = "select" | "rect" | "arrow" | "highlight" | "blur" | "text" | "badge" | "crop";

// 座標はすべて画像ピクセル空間 / All coordinates live in image-pixel space
export type RectShape = { x: number; y: number; w: number; h: number };

export type Obj =
  | ({ id: string; kind: "rect"; color: string } & RectShape)
  | ({ id: string; kind: "highlight"; color: string; opacity: number } & RectShape)
  | ({ id: string; kind: "blur" } & RectShape)
  | { id: string; kind: "arrow"; x1: number; y1: number; x2: number; y2: number; color: string }
  // color = 背景色（角丸の吹き出し）、textColor = 文字色（白/黒）、font = フォント、sizeMul = 基準サイズへの倍率
  // color = background (rounded pill), textColor = font color (white/black), font = typeface, sizeMul = multiplier on the base size
  | { id: string; kind: "text"; x: number; y: number; text: string; color: string; textColor: string; font: FontId; sizeMul: number }
  | { id: string; kind: "badge"; x: number; y: number; n: number; color: string; sizeMul: number };

export type Gesture =
  | { kind: "draw"; tool: Tool; ax: number; ay: number; id: string }
  | { kind: "move"; id: string; ox: number; oy: number }
  | { kind: "resize"; id: string; handle: string; start: Obj }
  | { kind: "crop-draw"; ax: number; ay: number }
  | { kind: "crop-resize"; handle: string; start: RectShape }
  | { kind: "crop-move"; ox: number; oy: number };

/// アノテーションの基準サイズ。画像の幅から算出し、プレビューと書き出しで同じ値を使う
/// Annotation base sizes derived from the image width; the preview and the export share them
export type Metrics = { stroke: number; fontSize: number; badgeR: number; blurPx: number };

export const COLORS = ["#fbbf24", "#ef4444", "#3b82f6", "#22c55e", "#18181b", "#ffffff"];

export const TOOLS: { tool: Tool; label: string }[] = [
  { tool: "select", label: "選択 / 移動" },
  { tool: "rect", label: "矩形枠" },
  { tool: "arrow", label: "矢印" },
  { tool: "text", label: "テキスト" },
  { tool: "highlight", label: "ハイライト" },
  { tool: "blur", label: "ぼかし" },
  { tool: "badge", label: "番号バッジ" },
  { tool: "crop", label: "トリミング" },
];

// 線幅プリセット / Line-width presets
export const STROKE_PRESETS: { label: string; mul: number; title: string }[] = [
  { label: "細", mul: 0.6, title: "線を細く" },
  { label: "中", mul: 1, title: "標準の線幅" },
  { label: "太", mul: 1.7, title: "線を太く" },
];

// フォントのプリセット。Windows/macOS両方の代表的な日本語フォントを並べ、最後に汎用ファミリーで受ける
// Font presets: representative Japanese fonts for both Windows and macOS, ending in a generic family fallback
export type FontId = "gothic" | "udgothic" | "mincho" | "kyokasho" | "mono";

export const TEXT_FONTS: { id: FontId; label: string; family: string }[] = [
  { id: "gothic", label: "ゴシック", family: '"Yu Gothic UI", "Hiragino Sans", "Segoe UI", sans-serif' },
  { id: "udgothic", label: "UDゴシック", family: '"BIZ UDPGothic", "Hiragino Maru Gothic ProN", "Yu Gothic UI", sans-serif' },
  { id: "mincho", label: "明朝", family: '"Yu Mincho", "Hiragino Mincho ProN", "MS PMincho", serif' },
  { id: "kyokasho", label: "教科書体", family: '"UD Digi Kyokasho NP-B", "UD Digi Kyokasho N-B", "Kyokasho ICA", "Hiragino Maru Gothic ProN", "Yu Gothic UI", sans-serif' },
  { id: "mono", label: "等幅", family: '"BIZ UDGothic", Consolas, Menlo, "Yu Gothic UI", monospace' },
];

export const DEFAULT_FONT: FontId = "gothic";

export const fontFamilyOf = (id: FontId) => (TEXT_FONTS.find((f) => f.id === id) ?? TEXT_FONTS[0]).family;

// サイズ倍率（基準サイズに掛ける）。範囲と刻み / Size multiplier (applied to the base size): range & step
export const SIZE_MUL_MIN = 0.5;
export const SIZE_MUL_MAX = 4;
export const SIZE_MUL_STEP = 0.1;
// 既定の倍率（新規作成時）。基準サイズだと大きすぎるため70% / Default multiplier for new objects (base size felt too big, so 70%)
export const DEFAULT_SIZE_MUL = 0.7;
export const clampSizeMul = (v: number) =>
  Math.round(Math.min(SIZE_MUL_MAX, Math.max(SIZE_MUL_MIN, v)) * 10) / 10;

// オブジェクト個別のフォントサイズ・バッジ半径 / Per-object font size and badge radius
export const textFontSize = (m: Metrics, sizeMul: number) => Math.max(8, Math.round(m.fontSize * sizeMul));
export const badgeRadius = (m: Metrics, sizeMul: number) => Math.max(6, Math.round(m.badgeR * sizeMul));

// バッジの数字色：白バッジでは黒、それ以外は白 / Badge digit color: black on white badges, white otherwise
export const badgeTextColor = (bg: string) => (bg.toLowerCase() === "#ffffff" ? "#18181b" : "#ffffff");

// テキスト吹き出しの余白・角丸半径（フォントサイズに比例） / Text-bubble padding & corner radius (proportional to font size)
export const textBubbleMetrics = (fontSize: number) => ({
  padding: fontSize * 0.35,
  radius: fontSize * 0.3,
});

/// 画像サイズからアノテーションの基準サイズを算出する / Derive annotation sizes from the image size
export function computeMetrics(imgWidth: number | null, strokeMul: number): Metrics {
  const baseStroke = imgWidth ? Math.max(3, Math.round(imgWidth / 450)) : 3;
  const fontSize = imgWidth ? Math.max(18, Math.round(imgWidth / 42)) : 18;
  return {
    stroke: Math.max(1, Math.round(baseStroke * strokeMul)),
    fontSize,
    badgeR: Math.round(fontSize * 0.57),
    blurPx: imgWidth ? Math.max(10, Math.round(imgWidth / 130)) : 10,
  };
}

let idCounter = 0;
export const nextId = () => `obj-${++idCounter}-${Date.now()}`;

export function normRect(ax: number, ay: number, bx: number, by: number): RectShape {
  return { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) };
}

// 複数行テキストの描画サイズを計測する（SVGプレビューとPNG書き出しで同じ余白計算に使う）。
// フォントごとにascent/descentの実測値が異なる（"Yu Gothic UI"/"Segoe UI"はmacOSに存在せず
// フォールバックフォントになる等）ため、固定倍率ではなくmeasureTextの実測値を使う。
// 使い捨てのオフスクリーンcanvasを使い回す。
// Measure multi-line text (shared by the SVG preview and PNG export for identical padding math).
// Ascent/descent vary by the font actually rendered (e.g. "Yu Gothic UI"/"Segoe UI" don't exist
// on macOS and fall back to something else), so use measureText's real metrics instead of a
// fixed multiplier. Reuses a throwaway offscreen canvas for measureText.
let measureCtx: CanvasRenderingContext2D | null = null;
export function measureTextLines(
  lines: string[],
  fontSize: number,
  font: FontId,
): { width: number; height: number; ascent: number; lineHeight: number } {
  const fallbackAscent = fontSize * 0.8;
  const fallbackDescent = fontSize * 0.25;
  if (!measureCtx) measureCtx = document.createElement("canvas").getContext("2d");
  const ctx = measureCtx;
  if (!ctx) {
    const lineHeight = (fallbackAscent + fallbackDescent) * 1.15;
    return { width: fontSize, height: lines.length * lineHeight, ascent: fallbackAscent, lineHeight };
  }
  ctx.font = `bold ${fontSize}px ${fontFamilyOf(font)}`;
  const width = Math.max(...lines.map((l) => ctx.measureText(l || " ").width), 1);
  // 行の内容（降下文字の有無等）で行送りがばらつかないよう、固定の参照文字列で測る
  // Measure a fixed reference string so line spacing doesn't jitter based on descenders etc.
  const ref = ctx.measureText("Mjpqy国あ");
  const ascent = ref.actualBoundingBoxAscent || fallbackAscent;
  const descent = ref.actualBoundingBoxDescent || fallbackDescent;
  const lineHeight = (ascent + descent) * 1.15;
  // 行間の余白（1.15倍分）は行と行の間だけに使う。1行分の天地にまで掛けると、
  // 単一行のときに下側だけ余白が余って見た目のバランスが崩れるため
  // The 1.15 leading only applies *between* lines. Multiplying the whole block by it
  // (including the outermost line) left extra slack stacked at the bottom for single-line text
  const height = ascent + descent + (lines.length - 1) * lineHeight;
  return { width, height, ascent, lineHeight };
}

// 矢印の先端形状。SVGプレビューとcanvas書き出しの両方が同じ幾何を使う
// Arrowhead geometry, shared by the SVG preview and the canvas export
export function arrowHead(x1: number, y1: number, x2: number, y2: number, size: number) {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const baseX = x2 - size * 0.8 * Math.cos(angle);
  const baseY = y2 - size * 0.8 * Math.sin(angle);
  const left = `${x2 - size * Math.cos(angle - 0.45)},${y2 - size * Math.sin(angle - 0.45)}`;
  const right = `${x2 - size * Math.cos(angle + 0.45)},${y2 - size * Math.sin(angle + 0.45)}`;
  return { baseX, baseY, points: `${x2},${y2} ${left} ${right}` };
}
