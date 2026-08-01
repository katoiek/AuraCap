// アノテーション付き画像のラスタライズ（書き出し経路）。
// 画面表示はSVGだが、出力は同じ幾何をcanvasで描き直して1枚の画像にする。
// Rasterization of the annotated image (the export path). The screen uses SVG, while
// export redraws the same geometry onto a canvas to produce a single flat image.

import {
  arrowHead,
  badgeTextColor,
  measureTextLines,
  textBubbleMetrics,
  TEXT_FONT,
  type Metrics,
  type Obj,
  type RectShape,
} from "./model";

export type ExportFormat = "png" | "jpg" | "webp";

function drawArrow(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  color: string,
  stroke: number,
) {
  const head = arrowHead(x1, y1, x2, y2, stroke * 4);
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = stroke;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(head.baseX, head.baseY);
  ctx.stroke();
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const size = stroke * 4;
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - size * Math.cos(angle - 0.45), y2 - size * Math.sin(angle - 0.45));
  ctx.lineTo(x2 - size * Math.cos(angle + 0.45), y2 - size * Math.sin(angle + 0.45));
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/// アノテーションを1つ描く。ぼかしだけは元画像を再描画するのでimgを受け取る
/// Draw one annotation; blur needs the source image because it redraws it through a filter
function drawObject(
  ctx: CanvasRenderingContext2D,
  o: Obj,
  img: CanvasImageSource,
  m: Metrics,
) {
  switch (o.kind) {
    case "blur":
      // ぼかし：該当領域だけフィルタをかけて再描画 / Blur: redraw just the region with a filter
      ctx.save();
      ctx.beginPath();
      ctx.rect(o.x, o.y, o.w, o.h);
      ctx.clip();
      ctx.filter = `blur(${m.blurPx}px)`;
      ctx.drawImage(img, 0, 0);
      ctx.restore();
      break;
    case "rect":
      ctx.strokeStyle = o.color;
      ctx.lineWidth = m.stroke;
      ctx.strokeRect(o.x, o.y, o.w, o.h);
      break;
    case "highlight":
      // 通常合成：不透明度100%で完全な塗りつぶしになるようにする（multiplyだと下地が透けて残る）
      // Normal blending so 100% opacity is a fully solid fill (multiply would still let the base show through)
      ctx.save();
      ctx.fillStyle = o.color;
      ctx.globalAlpha = o.opacity;
      ctx.fillRect(o.x, o.y, o.w, o.h);
      ctx.restore();
      break;
    case "arrow":
      drawArrow(ctx, o.x1, o.y1, o.x2, o.y2, o.color, m.stroke);
      break;
    case "text": {
      const lines = o.text.split("\n");
      const { width, height, ascent, lineHeight } = measureTextLines(lines, m.fontSize);
      const { padding, radius } = textBubbleMetrics(m.fontSize);
      ctx.save();
      ctx.fillStyle = o.color;
      ctx.beginPath();
      ctx.roundRect(o.x - padding, o.y - padding, width + padding * 2, height + padding * 2, radius);
      ctx.fill();
      ctx.font = `bold ${m.fontSize}px ${TEXT_FONT}`;
      ctx.textBaseline = "alphabetic";
      ctx.fillStyle = o.textColor;
      lines.forEach((line, i) => {
        ctx.fillText(line, o.x, o.y + ascent + i * lineHeight);
      });
      ctx.restore();
      break;
    }
    case "badge":
      ctx.save();
      ctx.fillStyle = o.color;
      ctx.beginPath();
      ctx.arc(o.x, o.y, m.badgeR, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = badgeTextColor(o.color);
      ctx.font = `bold ${Math.round(m.badgeR * 1.1)}px "Segoe UI", sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(o.n), o.x, o.y + m.badgeR * 0.05);
      ctx.restore();
      break;
  }
}

export type RasterizeInput = {
  img: CanvasImageSource;
  size: { w: number; h: number };
  objects: Obj[];
  crop: RectShape | null;
  metrics: Metrics;
  format: ExportFormat;
};

/// 元画像＋アノテーション＋トリミングを1枚に焼き込み、エンコード済みバイト列を返す
/// Bake the image, its annotations and the crop into one frame and return the encoded bytes
export async function rasterize({
  img,
  size,
  objects,
  crop,
  metrics,
  format,
}: RasterizeInput): Promise<Uint8Array | null> {
  const canvas = document.createElement("canvas");
  canvas.width = size.w;
  canvas.height = size.h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0);

  for (const o of objects) drawObject(ctx, o, img, metrics);

  // トリミング適用 / Apply crop
  let out = canvas;
  if (crop && crop.w > 2 && crop.h > 2) {
    const c2 = document.createElement("canvas");
    c2.width = Math.round(crop.w);
    c2.height = Math.round(crop.h);
    c2.getContext("2d")!.drawImage(canvas, -Math.round(crop.x), -Math.round(crop.y));
    out = c2;
  }

  // JPEGは透過を持てないため白背景で平坦化 / JPEG has no alpha, so flatten onto white
  if (format === "jpg") {
    const flat = document.createElement("canvas");
    flat.width = out.width;
    flat.height = out.height;
    const fctx = flat.getContext("2d")!;
    fctx.fillStyle = "#ffffff";
    fctx.fillRect(0, 0, flat.width, flat.height);
    fctx.drawImage(out, 0, 0);
    out = flat;
  }
  const mime = format === "jpg" ? "image/jpeg" : format === "webp" ? "image/webp" : "image/png";
  const quality = format === "png" ? undefined : 0.92;
  const blob = await new Promise<Blob | null>((resolve) => out.toBlob(resolve, mime, quality));
  if (!blob) return null;
  return new Uint8Array(await blob.arrayBuffer());
}
