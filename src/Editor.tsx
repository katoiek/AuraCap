import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { LogicalSize } from "@tauri-apps/api/dpi";

// 軽量エディタ：出力までは全アノテーションを再編集可能なオブジェクトとして保持する
// Quick editor: every annotation stays a re-editable object until export

type Tool = "select" | "rect" | "arrow" | "highlight" | "blur" | "text" | "badge" | "crop";

// 座標はすべて画像ピクセル空間 / All coordinates live in image-pixel space
type RectShape = { x: number; y: number; w: number; h: number };
type Obj =
  | ({ id: string; kind: "rect"; color: string } & RectShape)
  | ({ id: string; kind: "highlight"; color: string } & RectShape)
  | ({ id: string; kind: "blur" } & RectShape)
  | { id: string; kind: "arrow"; x1: number; y1: number; x2: number; y2: number; color: string }
  | { id: string; kind: "text"; x: number; y: number; text: string; color: string }
  | { id: string; kind: "badge"; x: number; y: number; n: number; color: string };

type Gesture =
  | { kind: "draw"; tool: Tool; ax: number; ay: number; id: string }
  | { kind: "move"; id: string; ox: number; oy: number }
  | { kind: "resize"; id: string; handle: string; start: Obj }
  | { kind: "crop-draw"; ax: number; ay: number }
  | { kind: "crop-resize"; handle: string; start: RectShape }
  | { kind: "crop-move"; ox: number; oy: number };

const COLORS = ["#fbbf24", "#ef4444", "#3b82f6", "#22c55e", "#18181b", "#ffffff"];

// バッジの数字色：白バッジでは黒、それ以外は白 / Badge digit color: black on white badges, white otherwise
const badgeTextColor = (bg: string) => (bg.toLowerCase() === "#ffffff" ? "#18181b" : "#ffffff");

const TOOLS: { tool: Tool; label: string }[] = [
  { tool: "select", label: "選択 / 移動" },
  { tool: "rect", label: "矩形枠" },
  { tool: "arrow", label: "矢印" },
  { tool: "text", label: "テキスト" },
  { tool: "highlight", label: "ハイライト" },
  { tool: "blur", label: "ぼかし" },
  { tool: "badge", label: "番号バッジ" },
  { tool: "crop", label: "トリミング" },
];

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

let idCounter = 0;
const nextId = () => `obj-${++idCounter}-${Date.now()}`;

function normRect(ax: number, ay: number, bx: number, by: number): RectShape {
  return { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) };
}

function Editor() {
  const [version, setVersion] = useState(0);
  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(null);
  const [objects, setObjects] = useState<Obj[]>([]);
  const [crop, setCrop] = useState<RectShape | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>("select");
  const [color, setColor] = useState(COLORS[0]);
  // 線幅の倍率（細0.6 / 中1.0 / 太1.7）。基準線幅に掛けて全体へ反映
  // Line-width multiplier (thin/medium/thick); multiplied into the base stroke globally
  const [strokeMul, setStrokeMul] = useState(1);
  const [fitScale, setFitScale] = useState(1);
  // 表示ズーム。nullはフィット表示（ウィンドウに合わせる） / Display zoom; null = fit to viewport
  const [zoom, setZoom] = useState<number | null>(null);
  const scale = zoom ?? fitScale;
  const [textEdit, setTextEdit] = useState<{ id: string | null; x: number; y: number; value: string } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  // Smart Redact実行中フラグ / Smart Redact in-flight flag
  const [redacting, setRedacting] = useState(false);
  // Screenshot-to-Code: 生成中フラグと生成結果 / Codegen in-flight flag and result
  const [generating, setGenerating] = useState(false);
  // 結果モーダル（コード生成・テキスト抽出で共用） / Result modal (shared by codegen & text extraction)
  const [resultModal, setResultModal] = useState<{ title: string; text: string } | null>(null);
  const [extracting, setExtracting] = useState(false);
  const modalTextRef = useRef<HTMLTextAreaElement | null>(null);
  // 生成経過秒数（ローカルLLMは数分かかるため進行が見えるように）
  // Elapsed seconds; local LLMs can take minutes, so show progress
  const [genElapsed, setGenElapsed] = useState(0);
  useEffect(() => {
    if (!generating) return;
    setGenElapsed(0);
    const t = setInterval(() => setGenElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [generating]);

  const imgRef = useRef<HTMLImageElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const toolbarRef = useRef<HTMLElement | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const undoStack = useRef<{ objects: Obj[]; crop: RectShape | null }[]>([]);
  const objectsRef = useRef(objects);
  objectsRef.current = objects;
  const cropRef = useRef(crop);
  cropRef.current = crop;

  // アノテーションの基準サイズ（画像サイズに比例） / Annotation base sizes proportional to the image
  const baseStroke = imgSize ? Math.max(3, Math.round(imgSize.w / 450)) : 3;
  const stroke = Math.max(1, Math.round(baseStroke * strokeMul));
  const fontSize = imgSize ? Math.max(18, Math.round(imgSize.w / 42)) : 18;
  const badgeR = Math.round(fontSize * 0.57);
  const blurPx = imgSize ? Math.max(10, Math.round(imgSize.w / 130)) : 10;

  const resetAll = useCallback(() => {
    setObjects([]);
    setCrop(null);
    setSelected(null);
    setTool("select");
    setTextEdit(null);
    setZoom(null);
    gesture.current = null;
    undoStack.current = [];
  }, []);

  // セッションイベント駆動（ウィンドウは常駐・使い回し） / Session-event driven (window is resident)
  useEffect(() => {
    const win = getCurrentWebviewWindow();
    const unlistenStart = win.listen("edit-start", () => {
      invoke("frontend_log", { message: "editor: edit-start received" });
      resetAll();
      setImgSize(null);
      setVersion(Date.now());
    });
    // 取りこぼし対策：マウント時点で編集対象が既にあれば自力で読み込む
    // （ウィンドウ生成直後のemitはJS読み込み前で届かないことがある）
    // Race guard: if an image is already pending at mount, load it ourselves
    // (an emit right after window creation can fire before JS has loaded)
    invoke<boolean>("editor_has_image").then((has) => {
      if (has) {
        invoke("frontend_log", { message: "editor: image pending at mount, loading" });
        setVersion((v) => v || Date.now());
      }
    });
    const unlistenEnd = win.listen("edit-end", () => {
      resetAll();
      setVersion(0);
      setImgSize(null);
    });
    // 保存完了はダイアログのコールバックから通知される / Save completion arrives from the dialog callback
    const unlistenSaved = win.listen<string | null>("export-saved", (e) => {
      // 自動保存時はフォルダ名をペイロードで受け取り保存先を知らせる
      // On auto-save the folder arrives as payload so we can show where it went
      const dir = typeof e.payload === "string" ? e.payload : "";
      setToast(dir ? `保存しました → ${dir}` : "保存しました");
      setTimeout(() => setToast(null), dir ? 2600 : 1800);
    });
    return () => {
      unlistenStart.then((f) => f());
      unlistenEnd.then((f) => f());
      unlistenSaved.then((f) => f());
    };
  }, [resetAll]);

  // 表示倍率：ビューポートに収まるようフィット / Fit-to-viewport display scale
  const recomputeScale = useCallback(() => {
    if (!imgSize || !viewportRef.current) return;
    const vw = viewportRef.current.clientWidth - 24;
    const vh = viewportRef.current.clientHeight - 24;
    setFitScale(Math.min(1, vw / imgSize.w, vh / imgSize.h));
  }, [imgSize]);

  useEffect(() => {
    recomputeScale();
    const ro = new ResizeObserver(recomputeScale);
    if (viewportRef.current) ro.observe(viewportRef.current);
    return () => ro.disconnect();
  }, [recomputeScale]);

  // ツールバーが収まる最低幅を確保する。縦長画像で窓が狭いとアイコンが潰れるため、
  // ツールバーの自然幅まで窓を広げる（モニター幅でクランプ）。画像が広ければ何もしない。
  // Ensure the window is at least wide enough for the toolbar; for narrow (portrait)
  // captures the icons would otherwise be squished. Widen to the toolbar's natural
  // width (clamped to the monitor). No-op when the image is already wider.
  useEffect(() => {
    if (!imgSize) return;
    const id = requestAnimationFrame(async () => {
      const tb = toolbarRef.current;
      if (!tb) return;
      const needed = tb.scrollWidth + 2; // ツールバーの自然幅 / toolbar's natural width
      if (needed <= window.innerWidth + 1) return; // 既に十分広い / already wide enough
      try {
        const win = getCurrentWebviewWindow();
        const scale = await win.scaleFactor();
        const outer = await win.outerSize();
        const chromeW = outer.width / scale - window.innerWidth;
        const maxInner = window.screen.availWidth * 0.96 - chromeW;
        const targetInner = Math.min(needed, maxInner);
        const outerH = outer.height / scale; // 高さは維持 / keep height
        await win.setSize(new LogicalSize(Math.ceil(targetInner + chromeW), Math.ceil(outerH)));
      } catch {
        /* ウィンドウ操作不可時は無視 / Ignore when the window op is unavailable */
      }
    });
    return () => cancelAnimationFrame(id);
  }, [imgSize]);

  // 段階ズーム / Stepped zoom levels
  const stepZoom = useCallback(
    (dir: 1 | -1) => {
      const levels = [0.1, 0.15, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4];
      const cur = zoom ?? fitScale;
      const next =
        dir > 0
          ? levels.find((l) => l > cur * 1.001)
          : [...levels].reverse().find((l) => l < cur * 0.999);
      if (next) setZoom(next);
    },
    [zoom, fitScale],
  );

  // Ctrl+ホイールでズーム。preventDefaultにはネイティブの非passiveリスナーが必要
  // Ctrl+wheel zoom; preventDefault needs a native non-passive listener
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      stepZoom(e.deltaY < 0 ? 1 : -1);
    };
    vp.addEventListener("wheel", onWheel, { passive: false });
    return () => vp.removeEventListener("wheel", onWheel);
  }, [stepZoom]);

  const pushUndo = useCallback(() => {
    undoStack.current.push({
      objects: structuredClone(objectsRef.current),
      crop: cropRef.current ? { ...cropRef.current } : null,
    });
    if (undoStack.current.length > 100) undoStack.current.shift();
  }, []);

  const undo = useCallback(() => {
    const prev = undoStack.current.pop();
    if (prev) {
      setObjects(prev.objects);
      setCrop(prev.crop);
      setSelected(null);
    }
  }, []);

  // クライアント座標→画像ピクセル座標 / Client coords → image-pixel coords
  const toImage = useCallback(
    (clientX: number, clientY: number) => {
      const svg = svgRef.current;
      const size = imgSize;
      if (!svg || !size) return { x: 0, y: 0 };
      const r = svg.getBoundingClientRect();
      return {
        x: Math.max(0, Math.min(size.w, ((clientX - r.left) / r.width) * size.w)),
        y: Math.max(0, Math.min(size.h, ((clientY - r.top) / r.height) * size.h)),
      };
    },
    [imgSize],
  );

  // ---- 書き出し / Export ----

  const renderToPng = useCallback(async (
    format: "png" | "jpg" | "webp" = "png",
  ): Promise<Uint8Array | null> => {
    const img = imgRef.current;
    if (!img || !imgSize) return null;
    const canvas = document.createElement("canvas");
    canvas.width = imgSize.w;
    canvas.height = imgSize.h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0);

    for (const o of objects) {
      if (o.kind === "blur") {
        // ぼかし：該当領域だけフィルタをかけて再描画 / Blur: redraw just the region with a filter
        ctx.save();
        ctx.beginPath();
        ctx.rect(o.x, o.y, o.w, o.h);
        ctx.clip();
        ctx.filter = `blur(${blurPx}px)`;
        ctx.drawImage(img, 0, 0);
        ctx.restore();
      } else if (o.kind === "rect") {
        ctx.strokeStyle = o.color;
        ctx.lineWidth = stroke;
        ctx.strokeRect(o.x, o.y, o.w, o.h);
      } else if (o.kind === "highlight") {
        ctx.save();
        ctx.globalCompositeOperation = "multiply";
        ctx.fillStyle = o.color;
        ctx.globalAlpha = 0.45;
        ctx.fillRect(o.x, o.y, o.w, o.h);
        ctx.restore();
      } else if (o.kind === "arrow") {
        drawArrow(ctx, o.x1, o.y1, o.x2, o.y2, o.color, stroke);
      } else if (o.kind === "text") {
        ctx.save();
        ctx.font = `bold ${fontSize}px "Yu Gothic UI", "Segoe UI", sans-serif`;
        ctx.textBaseline = "top";
        ctx.shadowColor = "rgba(0,0,0,0.45)";
        ctx.shadowBlur = 3;
        ctx.fillStyle = o.color;
        o.text.split("\n").forEach((line, i) => {
          ctx.fillText(line, o.x, o.y + i * fontSize * 1.25);
        });
        ctx.restore();
      } else if (o.kind === "badge") {
        ctx.save();
        ctx.fillStyle = o.color;
        ctx.beginPath();
        ctx.arc(o.x, o.y, badgeR, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = badgeTextColor(o.color);
        ctx.font = `bold ${Math.round(badgeR * 1.1)}px "Segoe UI", sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(String(o.n), o.x, o.y + badgeR * 0.05);
        ctx.restore();
      }
    }

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
  }, [objects, crop, imgSize, stroke, fontSize, badgeR, blurPx]);

  const showToast = useCallback((message: string, ms = 1800) => {
    setToast(message);
    setTimeout(() => setToast(null), ms);
  }, []);

  const doCopy = useCallback(async () => {
    const png = await renderToPng();
    if (!png) return;
    try {
      await invoke("export_copy", png);
      showToast("クリップボードへコピーしました");
    } catch (e) {
      invoke("frontend_log", { message: `export_copy failed: ${e}` });
    }
  }, [renderToPng, showToast]);

  const doSave = useCallback(async () => {
    // 設定の出力形式に合わせてエンコード（拡張子はバックエンドが同じ設定で付与）
    // Encode to the configured format (the backend names the file with the same setting)
    let format: "png" | "jpg" | "webp" = "png";
    try {
      const s = await invoke<{ saveFormat?: string }>("get_settings");
      const f = (s.saveFormat || "png").toLowerCase();
      format = f === "jpg" || f === "jpeg" ? "jpg" : f === "webp" ? "webp" : "png";
    } catch {
      /* 既定のpngで続行 / fall back to png */
    }
    const bytes = await renderToPng(format);
    if (!bytes) return;
    try {
      await invoke("export_save", bytes);
    } catch (e) {
      invoke("frontend_log", { message: `export_save failed: ${e}` });
    }
  }, [renderToPng]);

  // 付箋ピン留め：編集後の画像を最前面のフローティング窓としてデスクトップに貼る
  // Pin the edited image to the desktop as an always-on-top floating window
  const doPin = useCallback(async () => {
    const png = await renderToPng();
    if (!png) return;
    try {
      await invoke("pin_image", png);
      showToast("デスクトップにピン留めしました");
    } catch (e) {
      showToast(`ピン留めに失敗しました: ${String(e).slice(0, 120)}`);
      invoke("frontend_log", { message: `pin failed: ${e}` });
    }
  }, [renderToPng, showToast]);

  // Smart Redact: ローカルOCRで機密情報らしき領域を検出し、ぼかしとして追加する
  // Smart Redact: detect sensitive-looking regions with local OCR, add them as blurs
  const runRedact = useCallback(async () => {
    if (redacting) return;
    setRedacting(true);
    setToast("機密情報を検出中…");
    try {
      const regions = await invoke<{ x: number; y: number; w: number; h: number; kind: string }[]>(
        "detect_sensitive",
      );
      if (regions.length === 0) {
        showToast("機密らしき箇所は見つかりませんでした");
      } else {
        pushUndo();
        setObjects((os) => [
          ...os,
          ...regions.map((r) => ({ id: nextId(), kind: "blur" as const, x: r.x, y: r.y, w: r.w, h: r.h })),
        ]);
        showToast(`${regions.length}件をぼかしました（不要なものは選択してDelete）`);
      }
    } catch (e) {
      showToast(`検出に失敗しました: ${e}`);
      invoke("frontend_log", { message: `detect_sensitive failed: ${e}` });
    } finally {
      setRedacting(false);
    }
  }, [redacting, pushUndo, showToast]);

  // Screenshot-to-Code: 編集後の画像から単一HTMLを生成する（Claude API / ローカルOllama）
  // Screenshot-to-Code: generate a single-file HTML from the edited image (Claude API / local Ollama)
  const runCodegen = useCallback(async () => {
    if (generating) return;
    try {
      const settings = await invoke<{
        anthropicApiKey: string;
        codegenProvider: string;
        ollamaUrl: string;
        ollamaModel: string;
      }>("get_settings");
      const provider = settings.codegenProvider === "ollama" ? "ollama" : "claude";
      const apiKey = settings.anthropicApiKey?.trim();
      const ollamaModel = settings.ollamaModel?.trim();
      if (provider === "claude" && !apiKey) {
        showToast("メイン画面でClaude APIキーを設定してください");
        return;
      }
      if (provider === "ollama" && !ollamaModel) {
        showToast("メイン画面でOllamaのモデル名を設定してください");
        return;
      }
      const png = await renderToPng();
      if (!png) return;
      setGenerating(true);
      invoke("frontend_log", {
        message: `codegen start: provider=${provider} model=${provider === "ollama" ? ollamaModel : "claude-fable-5"}`,
      });
      // ハング対策の上限時間 / Hard cap against hangs
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 600_000);

      // 画像上限（Claudeは8000px）に収まるよう縮小し、サイズ削減のためJPEG化
      // Downscale within the image limit (8000px for Claude); JPEG keeps the payload small
      const bitmap = await createImageBitmap(new Blob([png as BlobPart], { type: "image/png" }));
      const k = Math.min(1, 7800 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * k));
      canvas.height = Math.max(1, Math.round(bitmap.height * k));
      canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      const dataUrl = canvas.toDataURL("image/jpeg", 0.9);
      const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);

      const prompt =
        "このUIスクリーンショットを、Tailwind CSS（CDN版）を使った単一のHTMLファイルとして忠実に再現してください。" +
        "レイアウト・配色・余白・フォントサイズをできるだけ正確に。写真やイラスト部分はプレースホルダーで構いません。" +
        "完全なHTMLコードのみを出力してください（説明文・コードフェンスは不要）。";

      let code: string;
      if (provider === "ollama") {
        // OllamaネイティブAPI。Rust経由で呼ぶ（WebViewのfetchはCORSで弾かれる。完全ローカル・無料、要: ビジョン対応モデル）
        // Ollama's native API via Rust (WebView fetch is blocked by CORS); fully local & free, needs a vision-capable model
        code = await invoke<string>("ollama_generate", {
          url: settings.ollamaUrl?.trim() || "http://127.0.0.1:11434",
          model: ollamaModel,
          prompt,
          imageBase64: base64,
        });
      } else {
        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          signal: controller.signal,
          headers: {
            "content-type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            // WebViewから直接呼ぶための明示オプトイン / Explicit opt-in for direct browser calls
            "anthropic-dangerous-direct-browser-access": "true",
          },
          body: JSON.stringify({
            model: "claude-fable-5",
            max_tokens: 16000,
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "image",
                    source: { type: "base64", media_type: "image/jpeg", data: base64 },
                  },
                  { type: "text", text: prompt },
                ],
              },
            ],
          }),
        });
        if (!res.ok) {
          const body = await res.text();
          throw new Error(`API ${res.status}: ${body.slice(0, 200)}`);
        }
        const data = await res.json();
        code = (data.content ?? [])
          .filter((b: { type: string }) => b.type === "text")
          .map((b: { text: string }) => b.text)
          .join("\n");
      }

      clearTimeout(timeoutId);
      // コードフェンス付きで返ってきた場合は剥がす / Strip code fences if present
      code = code.replace(/^```[a-z]*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
      setResultModal({ title: "生成されたHTML（Tailwind CSS）", text: code || "（出力が空でした）" });
    } catch (e) {
      const message =
        e instanceof DOMException && e.name === "AbortError"
          ? "コード生成がタイムアウトしました（10分）。モデルやマシン負荷を確認してください"
          : `コード生成に失敗しました: ${String(e).slice(0, 160)}`;
      showToast(message, 6000);
      invoke("frontend_log", { message: `codegen failed: ${e}` });
    } finally {
      setGenerating(false);
    }
  }, [generating, renderToPng, showToast]);

  // テキスト抽出: ローカルOCRで画像内の文字を読み取りモーダルに表示する
  // Text extraction: read on-image text with local OCR and show it in the modal
  const runExtractText = useCallback(async () => {
    if (extracting) return;
    setExtracting(true);
    try {
      // トリミング範囲があればその矩形だけOCR、なければ全体 / OCR the crop region if set, else the whole image
      const rect = cropRef.current
        ? { x: cropRef.current.x, y: cropRef.current.y, w: cropRef.current.w, h: cropRef.current.h }
        : null;
      const text = await invoke<string>("extract_text", { rect });
      if (!text.trim()) {
        showToast("テキストが見つかりませんでした");
      } else {
        setResultModal({ title: "抽出されたテキスト", text });
      }
    } catch (e) {
      showToast(`テキスト抽出に失敗しました: ${String(e).slice(0, 120)}`);
      invoke("frontend_log", { message: `extract_text failed: ${e}` });
    } finally {
      setExtracting(false);
    }
  }, [extracting, showToast]);

  // ---- キーボード / Keyboard ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (textEdit) return; // テキスト入力中は奪わない / Don't steal keys while typing
      if (e.key === "Escape") setSelected(null);
      if ((e.key === "Delete" || e.key === "Backspace") && selected) {
        pushUndo();
        setObjects((os) => os.filter((o) => o.id !== selected));
        setSelected(null);
      }
      if (e.ctrlKey && e.key.toLowerCase() === "z") undo();
      if (e.ctrlKey && e.key.toLowerCase() === "c") doCopy();
      if (e.ctrlKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        doSave();
      }
      // 表示ズーム / Display zoom
      if (e.ctrlKey && (e.key === "+" || e.key === "=" || e.key === ";")) {
        e.preventDefault();
        stepZoom(1);
      }
      if (e.ctrlKey && e.key === "-") {
        e.preventDefault();
        stepZoom(-1);
      }
      if (e.ctrlKey && e.key === "0") {
        e.preventDefault();
        setZoom(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, textEdit, undo, doCopy, doSave, pushUndo, stepZoom]);

  // ---- ポインタ操作 / Pointer interactions ----

  const commitText = useCallback(() => {
    setTextEdit((te) => {
      if (!te) return null;
      const value = te.value.trim();
      if (te.id) {
        pushUndo();
        setObjects((os) =>
          value
            ? os.map((o) => (o.id === te.id && o.kind === "text" ? { ...o, text: value } : o))
            : os.filter((o) => o.id !== te.id),
        );
      } else if (value) {
        pushUndo();
        setObjects((os) => [...os, { id: nextId(), kind: "text", x: te.x, y: te.y, text: value, color }]);
      }
      return null;
    });
  }, [color, pushUndo]);

  const onStagePointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || !imgSize) return;
    if (textEdit) {
      commitText();
      return;
    }
    const p = toImage(e.clientX, e.clientY);
    const target = e.target as SVGElement;
    const objId = target.dataset.obj;
    const handle = target.dataset.handle;
    const cropHandle = target.dataset.crophandle;

    (e.currentTarget as Element).setPointerCapture(e.pointerId);

    // クロップのハンドル / Crop handles
    if (cropHandle && crop) {
      pushUndo();
      if (cropHandle === "move") {
        gesture.current = { kind: "crop-move", ox: p.x - crop.x, oy: p.y - crop.y };
      } else {
        gesture.current = { kind: "crop-resize", handle: cropHandle, start: { ...crop } };
      }
      return;
    }

    // オブジェクトのリサイズハンドル / Object resize handles
    if (handle && selected) {
      const obj = objects.find((o) => o.id === selected);
      if (obj) {
        pushUndo();
        gesture.current = { kind: "resize", id: selected, handle, start: structuredClone(obj) };
        return;
      }
    }

    // オブジェクト本体：選択して移動開始 / Object body: select & start moving
    if (objId && tool === "select") {
      const obj = objects.find((o) => o.id === objId);
      if (obj) {
        setSelected(objId);
        pushUndo();
        const ref = obj.kind === "arrow" ? { x: obj.x1, y: obj.y1 } : { x: obj.x, y: obj.y };
        gesture.current = { kind: "move", id: objId, ox: p.x - ref.x, oy: p.y - ref.y };
        return;
      }
    }

    // 背景：ツールに応じて新規作成 / Background: create per active tool
    setSelected(null);
    if (tool === "text") {
      setTextEdit({ id: null, x: p.x, y: p.y, value: "" });
      return;
    }
    if (tool === "badge") {
      pushUndo();
      const n = objects.reduce((m, o) => (o.kind === "badge" ? Math.max(m, o.n) : m), 0) + 1;
      setObjects((os) => [...os, { id: nextId(), kind: "badge", x: p.x, y: p.y, n, color }]);
      return;
    }
    if (tool === "crop") {
      pushUndo();
      gesture.current = { kind: "crop-draw", ax: p.x, ay: p.y };
      setCrop({ x: p.x, y: p.y, w: 0, h: 0 });
      return;
    }
    if (tool === "rect" || tool === "highlight" || tool === "blur" || tool === "arrow") {
      pushUndo();
      const id = nextId();
      gesture.current = { kind: "draw", tool, ax: p.x, ay: p.y, id };
      if (tool === "arrow") {
        setObjects((os) => [...os, { id, kind: "arrow", x1: p.x, y1: p.y, x2: p.x, y2: p.y, color }]);
      } else {
        const base = { id, x: p.x, y: p.y, w: 0, h: 0 } as const;
        setObjects((os) => [
          ...os,
          tool === "blur" ? { ...base, kind: "blur" } : { ...base, kind: tool, color },
        ]);
      }
      setSelected(id);
    }
  };

  const onStagePointerMove = (e: React.PointerEvent) => {
    const g = gesture.current;
    if (!g || !imgSize) return;
    const p = toImage(e.clientX, e.clientY);

    if (g.kind === "draw") {
      setObjects((os) =>
        os.map((o) => {
          if (o.id !== g.id) return o;
          if (o.kind === "arrow") return { ...o, x2: p.x, y2: p.y };
          return { ...o, ...normRect(g.ax, g.ay, p.x, p.y) };
        }),
      );
    } else if (g.kind === "move") {
      setObjects((os) =>
        os.map((o) => {
          if (o.id !== g.id) return o;
          if (o.kind === "arrow") {
            const dx = p.x - g.ox - o.x1;
            const dy = p.y - g.oy - o.y1;
            return { ...o, x1: o.x1 + dx, y1: o.y1 + dy, x2: o.x2 + dx, y2: o.y2 + dy };
          }
          return { ...o, x: p.x - g.ox, y: p.y - g.oy };
        }),
      );
    } else if (g.kind === "resize") {
      setObjects((os) =>
        os.map((o) => {
          if (o.id !== g.id) return o;
          const s = g.start;
          if (o.kind === "arrow" && s.kind === "arrow") {
            return g.handle === "p1" ? { ...o, x1: p.x, y1: p.y } : { ...o, x2: p.x, y2: p.y };
          }
          if ("w" in o && "w" in s) {
            let l = s.x, t = s.y, r = s.x + s.w, b = s.y + s.h;
            if (g.handle.includes("w")) l = p.x;
            if (g.handle.includes("e")) r = p.x;
            if (g.handle.includes("n")) t = p.y;
            if (g.handle.includes("s")) b = p.y;
            return { ...o, ...normRect(l, t, r, b) };
          }
          return o;
        }),
      );
    } else if (g.kind === "crop-draw") {
      setCrop(normRect(g.ax, g.ay, p.x, p.y));
    } else if (g.kind === "crop-move" && crop) {
      const x = Math.max(0, Math.min(p.x - g.ox, imgSize.w - crop.w));
      const y = Math.max(0, Math.min(p.y - g.oy, imgSize.h - crop.h));
      setCrop({ ...crop, x, y });
    } else if (g.kind === "crop-resize") {
      const s = g.start;
      let l = s.x, t = s.y, r = s.x + s.w, b = s.y + s.h;
      if (g.handle.includes("w")) l = p.x;
      if (g.handle.includes("e")) r = p.x;
      if (g.handle.includes("n")) t = p.y;
      if (g.handle.includes("s")) b = p.y;
      setCrop(normRect(l, t, r, b));
    }
  };

  const onStagePointerUp = () => {
    const g = gesture.current;
    gesture.current = null;
    if (!g) return;
    if (g.kind === "draw") {
      // 極小オブジェクトは破棄 / Discard tiny accidental objects
      setObjects((os) =>
        os.filter((o) => {
          if (o.id !== g.id) return true;
          if (o.kind === "arrow") return Math.hypot(o.x2 - o.x1, o.y2 - o.y1) > 6;
          return "w" in o && o.w > 4 && o.h > 4;
        }),
      );
    }
    if (g.kind === "crop-draw" && crop && (crop.w < 8 || crop.h < 8)) {
      setCrop(null);
    }
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    // テキストのダブルクリックで再編集 / Double-click a text object to re-edit
    const objId = (e.target as SVGElement).dataset.obj;
    const obj = objects.find((o) => o.id === objId);
    if (obj?.kind === "text") {
      setTextEdit({ id: obj.id, x: obj.x, y: obj.y, value: obj.text });
      setSelected(null);
    }
  };

  if (!version) {
    return (
      <div className="grid h-screen w-screen place-items-center bg-zinc-900 text-sm text-zinc-500">
        キャプチャ待機中…
      </div>
    );
  }

  const selectedObj = objects.find((o) => o.id === selected) ?? null;
  const handleR = 6 / Math.max(scale, 0.01);

  // 色を選ぶ。選択中オブジェクトがあればその色も変更する
  // Pick a color; also recolor the selected object if any
  const chooseColor = (c: string) => {
    setColor(c);
    if (selected) {
      pushUndo();
      setObjects((os) => os.map((o) => (o.id === selected && "color" in o ? { ...o, color: c } : o)));
    }
  };

  // スポイト: ウィンドウ上の任意の色を吸い取る（WebView2のEyeDropper API）
  // Eyedropper: sample any color on the window via WebView2's EyeDropper API
  const pickWithEyeDropper = async () => {
    const ED = (window as unknown as { EyeDropper?: new () => { open: () => Promise<{ sRGBHex: string }> } }).EyeDropper;
    if (!ED) {
      setToast("スポイトはこの環境では使えません");
      return;
    }
    try {
      const res = await new ED().open();
      if (res?.sRGBHex) chooseColor(res.sRGBHex);
    } catch {
      /* ユーザーがキャンセル / user canceled */
    }
  };

  // 線幅プリセット / Line-width presets
  const STROKE_PRESETS: { label: string; mul: number; title: string }[] = [
    { label: "細", mul: 0.6, title: "線を細く" },
    { label: "中", mul: 1, title: "標準の線幅" },
    { label: "太", mul: 1.7, title: "線を太く" },
  ];

  return (
    <div className="flex h-screen w-screen flex-col bg-zinc-900 text-zinc-100">
      {/* ツールバー / Toolbar */}
      <header
        ref={toolbarRef}
        className="flex items-center gap-1 overflow-x-auto border-b border-zinc-800 px-2 py-1.5 [&>*]:shrink-0"
      >
        {TOOLS.map((t) => (
          <button
            key={t.tool}
            title={t.label}
            onClick={() => {
              setTool(t.tool);
              setSelected(null);
            }}
            className={`grid h-9 w-9 place-items-center rounded-lg transition-colors ${
              tool === t.tool ? "bg-[var(--accent)] text-zinc-900" : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
            }`}
          >
            <ToolIcon tool={t.tool} />
          </button>
        ))}
        {crop && (
          <button
            onClick={() => {
              pushUndo();
              setCrop(null);
            }}
            className="ml-1 rounded-lg bg-zinc-800 px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700"
          >
            トリミング解除
          </button>
        )}
        <div className="mx-2 h-6 w-px bg-zinc-700" />
        {/* 線幅プリセット / Line-width presets */}
        {STROKE_PRESETS.map((p) => (
          <button
            key={p.label}
            title={p.title}
            onClick={() => setStrokeMul(p.mul)}
            className={`grid h-9 w-9 place-items-center rounded-lg text-xs transition-colors ${
              strokeMul === p.mul ? "bg-[var(--accent)] text-zinc-900" : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
            }`}
          >
            {p.label}
          </button>
        ))}
        <div className="mx-2 h-6 w-px bg-zinc-700" />
        {COLORS.map((c) => (
          <button
            key={c}
            onClick={() => chooseColor(c)}
            className={`h-6 w-6 rounded-full border-2 ${color === c ? "border-white" : "border-zinc-600"}`}
            style={{ backgroundColor: c }}
          />
        ))}
        {/* 自由色（カラーピッカー） / Custom color picker */}
        <label
          title="自由な色を選ぶ"
          className={`relative grid h-6 w-6 cursor-pointer place-items-center overflow-hidden rounded-full border-2 ${
            COLORS.includes(color) ? "border-zinc-600" : "border-white"
          }`}
          style={{ backgroundColor: COLORS.includes(color) ? "transparent" : color }}
        >
          {COLORS.includes(color) && <span className="text-[11px] leading-none">🎨</span>}
          <input
            type="color"
            value={color}
            onChange={(e) => chooseColor(e.target.value)}
            className="absolute inset-0 cursor-pointer opacity-0"
          />
        </label>
        {/* スポイト / Eyedropper */}
        <button
          onClick={pickWithEyeDropper}
          title="画面から色を吸い取る（スポイト）"
          className="grid h-9 w-9 place-items-center rounded-lg bg-zinc-800 text-base text-zinc-300 hover:bg-zinc-700"
        >
          🧪
        </button>
        <div className="mx-2 h-6 w-px bg-zinc-700" />
        {/* Smart Redact（ローカルOCR） / Smart Redact (local OCR) */}
        <button
          onClick={runRedact}
          disabled={redacting}
          title="メール・電話番号・APIキー等を検出してぼかします（ローカル処理、外部送信なし）"
          className="rounded-lg bg-zinc-800 px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700 disabled:opacity-50"
        >
          {redacting ? "検出中…" : "🛡 自動マスク"}
        </button>
        {/* テキスト抽出（ローカルOCR） / Text extraction (local OCR) */}
        <button
          onClick={runExtractText}
          disabled={extracting}
          title="画像内の文字をOCRで読み取ってコピーできます（ローカル処理、外部送信なし）"
          className="rounded-lg bg-zinc-800 px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700 disabled:opacity-50"
        >
          {extracting ? "抽出中…" : "📋 テキスト抽出"}
        </button>
        {/* Screenshot-to-Code（Claude API） */}
        <button
          onClick={runCodegen}
          disabled={generating}
          title="このスクリーンショットからTailwind CSSのHTMLを生成します（Claude API使用）"
          className="rounded-lg bg-zinc-800 px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700 disabled:opacity-50"
        >
          {generating ? `生成中… ${genElapsed}s` : "⧉ コード生成"}
        </button>
        <div className="mx-2 h-6 w-px bg-zinc-700" />
        {/* 表示ズーム / Display zoom */}
        <button
          onClick={() => stepZoom(-1)}
          title="ズームアウト (Ctrl+-)"
          className="grid h-8 w-8 place-items-center rounded-lg bg-zinc-800 text-base text-zinc-300 hover:bg-zinc-700"
        >
          −
        </button>
        <button
          onClick={() => setZoom(null)}
          title="ウィンドウに合わせる (Ctrl+0)"
          className={`min-w-14 rounded-lg px-2 py-1.5 text-center font-mono text-xs hover:bg-zinc-700 ${
            zoom === null ? "bg-zinc-800 text-zinc-400" : "bg-zinc-700 text-[var(--accent)]"
          }`}
        >
          {Math.round(scale * 100)}%
        </button>
        <button
          onClick={() => stepZoom(1)}
          title="ズームイン (Ctrl++ / Ctrl+ホイール)"
          className="grid h-8 w-8 place-items-center rounded-lg bg-zinc-800 text-base text-zinc-300 hover:bg-zinc-700"
        >
          ＋
        </button>
        <div className="ml-auto flex items-center gap-1.5">
          <button
            onClick={doPin}
            className="rounded-lg bg-zinc-800 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-700"
            title="デスクトップに常に最前面で貼り付け"
          >
            📌 ピン
          </button>
          <button
            onClick={doCopy}
            className="rounded-lg bg-[var(--accent)] px-3.5 py-1.5 text-sm font-semibold text-zinc-900 hover:bg-[var(--accent-strong)]"
            title="Ctrl+C"
          >
            コピー
          </button>
          <button
            onClick={doSave}
            className="rounded-lg bg-zinc-800 px-3.5 py-1.5 text-sm text-zinc-200 hover:bg-zinc-700"
            title="Ctrl+S"
          >
            保存
          </button>
          <button
            onClick={() => invoke("close_editor")}
            className="rounded-lg bg-zinc-800 px-3 py-1.5 text-sm text-zinc-400 hover:bg-zinc-700"
          >
            閉じる
          </button>
        </div>
      </header>

      {/* ステージ / Stage */}
      {/* ズーム時にスクロールできるようoverflow-auto、小さい画像はm-autoで中央寄せ */}
      {/* overflow-auto enables scrolling when zoomed; m-auto centers small images */}
      <div ref={viewportRef} className="flex flex-1 overflow-auto p-3">
        {imgSize === null && <div className="m-auto text-sm text-zinc-500">読み込み中…</div>}
        <div
          className="relative m-auto"
          style={imgSize ? { width: imgSize.w * scale, height: imgSize.h * scale } : { width: 0, height: 0 }}
        >
          <img
            ref={imgRef}
            src={`http://edit.localhost/current?v=${version}`}
            crossOrigin="anonymous"
            className="absolute inset-0 h-full w-full"
            draggable={false}
            alt=""
            onLoad={(e) => {
              const el = e.currentTarget;
              invoke("frontend_log", { message: `editor: image loaded ${el.naturalWidth}x${el.naturalHeight}` });
              setImgSize({ w: el.naturalWidth, h: el.naturalHeight });
              invoke("editor_ready");
            }}
            onError={() => invoke("frontend_log", { message: "editor image failed to load" })}
          />

          {imgSize && (
            <>
              {/* ぼかしプレビュー / Blur previews (CSS backdrop-filter) */}
              {objects
                .filter((o): o is Extract<Obj, { kind: "blur" }> => o.kind === "blur")
                .map((o) => (
                  <div
                    key={o.id}
                    className="pointer-events-none absolute"
                    style={{
                      left: o.x * scale,
                      top: o.y * scale,
                      width: o.w * scale,
                      height: o.h * scale,
                      backdropFilter: `blur(${blurPx * scale}px)`,
                    }}
                  />
                ))}

              <svg
                ref={svgRef}
                viewBox={`0 0 ${imgSize.w} ${imgSize.h}`}
                className={`absolute inset-0 h-full w-full ${tool === "select" ? "" : "cursor-crosshair"}`}
                onPointerDown={onStagePointerDown}
                onPointerMove={onStagePointerMove}
                onPointerUp={onStagePointerUp}
                onDoubleClick={onDoubleClick}
              >
                {objects.map((o) => {
                  const sel = o.id === selected;
                  const common = {
                    "data-obj": o.id,
                    style: { cursor: tool === "select" ? "move" : undefined },
                  };
                  if (o.kind === "rect")
                    return (
                      <rect key={o.id} {...common} x={o.x} y={o.y} width={o.w} height={o.h} fill="transparent" stroke={o.color} strokeWidth={stroke} />
                    );
                  if (o.kind === "highlight")
                    return (
                      <rect key={o.id} {...common} x={o.x} y={o.y} width={o.w} height={o.h} fill={o.color} fillOpacity={0.45} style={{ ...common.style, mixBlendMode: "multiply" }} />
                    );
                  if (o.kind === "blur")
                    return (
                      <rect key={o.id} {...common} x={o.x} y={o.y} width={o.w} height={o.h} fill="transparent" stroke={sel ? "#fbbf24" : "rgba(255,255,255,0.4)"} strokeWidth={sel ? stroke / 2 : 1 / scale} strokeDasharray={`${4 / scale} ${4 / scale}`} />
                    );
                  if (o.kind === "arrow") {
                    const head = arrowHead(o.x1, o.y1, o.x2, o.y2, stroke * 4);
                    return (
                      <g key={o.id} {...common}>
                        <line data-obj={o.id} x1={o.x1} y1={o.y1} x2={head.baseX} y2={head.baseY} stroke={o.color} strokeWidth={stroke} />
                        <polygon data-obj={o.id} points={head.points} fill={o.color} />
                        {/* 当たり判定を広げる透明ライン / Fat transparent line for easier hit-testing */}
                        <line data-obj={o.id} x1={o.x1} y1={o.y1} x2={o.x2} y2={o.y2} stroke="transparent" strokeWidth={Math.max(stroke * 4, 14 / scale)} />
                      </g>
                    );
                  }
                  if (o.kind === "text")
                    return (
                      <text key={o.id} {...common} x={o.x} y={o.y} fill={o.color} fontSize={fontSize} fontWeight="bold" dominantBaseline="hanging" fontFamily='"Yu Gothic UI", "Segoe UI", sans-serif' style={{ ...common.style, paintOrder: "stroke" }} stroke="rgba(0,0,0,0.35)" strokeWidth={stroke / 3}>
                        {o.text.split("\n").map((line, i) => (
                          <tspan key={i} x={o.x} dy={i === 0 ? 0 : fontSize * 1.25}>
                            {line}
                          </tspan>
                        ))}
                      </text>
                    );
                  if (o.kind === "badge")
                    return (
                      <g key={o.id} {...common}>
                        <circle data-obj={o.id} cx={o.x} cy={o.y} r={badgeR} fill={o.color} />
                        <text data-obj={o.id} x={o.x} y={o.y} fill={badgeTextColor(o.color)} fontSize={badgeR * 1.1} fontWeight="bold" textAnchor="middle" dominantBaseline="central" fontFamily='"Segoe UI", sans-serif'>
                          {o.n}
                        </text>
                      </g>
                    );
                  return null;
                })}

                {/* 選択ハンドル / Selection handles */}
                {selectedObj && selectedObj.kind === "arrow" && (
                  <>
                    <circle data-handle="p1" cx={selectedObj.x1} cy={selectedObj.y1} r={handleR} fill="#fbbf24" stroke="#18181b" strokeWidth={1.5 / scale} style={{ cursor: "grab" }} />
                    <circle data-handle="p2" cx={selectedObj.x2} cy={selectedObj.y2} r={handleR} fill="#fbbf24" stroke="#18181b" strokeWidth={1.5 / scale} style={{ cursor: "grab" }} />
                  </>
                )}
                {selectedObj && "w" in selectedObj && (
                  <>
                    <rect x={selectedObj.x} y={selectedObj.y} width={selectedObj.w} height={selectedObj.h} fill="none" stroke="#fbbf24" strokeWidth={1 / scale} strokeDasharray={`${4 / scale} ${4 / scale}`} pointerEvents="none" />
                    {["nw", "ne", "sw", "se"].map((h) => (
                      <rect
                        key={h}
                        data-handle={h}
                        x={(h.includes("w") ? selectedObj.x : selectedObj.x + selectedObj.w) - handleR}
                        y={(h.includes("n") ? selectedObj.y : selectedObj.y + selectedObj.h) - handleR}
                        width={handleR * 2}
                        height={handleR * 2}
                        fill="#fbbf24"
                        stroke="#18181b"
                        strokeWidth={1.5 / scale}
                        style={{ cursor: h === "nw" || h === "se" ? "nwse-resize" : "nesw-resize" }}
                      />
                    ))}
                  </>
                )}

                {/* トリミング表示 / Crop visualization */}
                {crop && (
                  <>
                    <path
                      d={`M0 0 H${imgSize.w} V${imgSize.h} H0 Z M${crop.x} ${crop.y} h${crop.w} v${crop.h} h${-crop.w} Z`}
                      fill="rgba(0,0,0,0.55)"
                      fillRule="evenodd"
                      pointerEvents="none"
                    />
                    <rect data-crophandle="move" x={crop.x} y={crop.y} width={crop.w} height={crop.h} fill="transparent" stroke="#fff" strokeWidth={1.5 / scale} strokeDasharray={`${6 / scale} ${4 / scale}`} style={{ cursor: "move" }} />
                    {["nw", "ne", "sw", "se"].map((h) => (
                      <rect
                        key={h}
                        data-crophandle={h}
                        x={(h.includes("w") ? crop.x : crop.x + crop.w) - handleR}
                        y={(h.includes("n") ? crop.y : crop.y + crop.h) - handleR}
                        width={handleR * 2}
                        height={handleR * 2}
                        fill="#fff"
                        stroke="#18181b"
                        strokeWidth={1.5 / scale}
                        style={{ cursor: h === "nw" || h === "se" ? "nwse-resize" : "nesw-resize" }}
                      />
                    ))}
                  </>
                )}
              </svg>

              {/* テキスト入力 / Inline text input */}
              {textEdit && (
                <textarea
                  autoFocus
                  value={textEdit.value}
                  onChange={(e) => setTextEdit({ ...textEdit, value: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      commitText();
                    }
                    if (e.key === "Escape") setTextEdit(null);
                  }}
                  onBlur={commitText}
                  placeholder="テキスト… (Enterで確定)"
                  className="absolute resize-none rounded border border-[var(--accent)] bg-zinc-900/80 px-1 py-0.5 font-bold outline-none"
                  style={{
                    left: textEdit.x * scale - 2,
                    top: textEdit.y * scale - 2,
                    minWidth: 160,
                    color,
                    fontSize: Math.max(12, fontSize * scale),
                    lineHeight: 1.25,
                  }}
                  rows={Math.max(1, textEdit.value.split("\n").length)}
                />
              )}
            </>
          )}
        </div>
      </div>

      {/* トースト / Toast */}
      {toast && (
        <div className="pointer-events-none absolute bottom-5 left-1/2 -translate-x-1/2 rounded-lg bg-zinc-800 px-4 py-2 text-sm text-[var(--accent)] shadow-lg">
          {toast}
        </div>
      )}

      {/* 結果モーダル（コード生成・テキスト抽出で共用） / Result modal (codegen & text extraction) */}
      {resultModal !== null && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-6">
          <div className="flex h-[80vh] max-h-full w-full max-w-3xl flex-col rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl">
            <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-2.5">
              <h2 className="text-sm font-semibold">{resultModal.title}</h2>
              <div className="flex gap-1.5">
                <button
                  onClick={() => {
                    // 選択範囲があればそれを、なければ全文をコピー
                    // Copy the selection if any, otherwise the whole text
                    const ta = modalTextRef.current;
                    const sel = ta ? ta.value.substring(ta.selectionStart, ta.selectionEnd) : "";
                    const toCopy = sel || ta?.value || resultModal.text;
                    navigator.clipboard.writeText(toCopy);
                    showToast(sel ? "選択範囲をコピーしました" : "コピーしました");
                  }}
                  className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-zinc-900 hover:bg-[var(--accent-strong)]"
                >
                  コピー
                </button>
                <button
                  onClick={() => setResultModal(null)}
                  className="rounded-lg bg-zinc-800 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700"
                >
                  閉じる
                </button>
              </div>
            </div>
            {/* 編集・選択できるテキストエリア（部分選択コピー用） / Editable, selectable area for partial-copy */}
            <textarea
              ref={modalTextRef}
              key={`${resultModal.title}:${resultModal.text.length}`}
              defaultValue={resultModal.text}
              spellCheck={false}
              className="min-h-0 flex-1 resize-none overflow-auto bg-transparent p-4 font-mono text-xs leading-relaxed text-zinc-300 focus:outline-none"
            />
          </div>
        </div>
      )}
    </div>
  );
}

// 矢印の先端形状 / Arrowhead geometry
function arrowHead(x1: number, y1: number, x2: number, y2: number, size: number) {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const baseX = x2 - size * 0.8 * Math.cos(angle);
  const baseY = y2 - size * 0.8 * Math.sin(angle);
  const left = `${x2 - size * Math.cos(angle - 0.45)},${y2 - size * Math.sin(angle - 0.45)}`;
  const right = `${x2 - size * Math.cos(angle + 0.45)},${y2 - size * Math.sin(angle + 0.45)}`;
  return { baseX, baseY, points: `${x2},${y2} ${left} ${right}` };
}

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

export default Editor;
