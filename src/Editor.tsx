import { useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { LogicalSize } from "@tauri-apps/api/dpi";
import ResultModal from "./editor/ResultModal";
import Toolbar from "./editor/Toolbar";
import { rasterize } from "./editor/raster";
import {
  arrowHead,
  badgeTextColor,
  COLORS,
  computeMetrics,
  measureTextLines,
  nextId,
  normRect,
  textBubbleMetrics,
  TEXT_FONT,
  type Gesture,
  type Obj,
  type RectShape,
  type Tool,
} from "./editor/model";

// 軽量エディタ：出力までは全アノテーションを再編集可能なオブジェクトとして保持する。
// このファイルは状態とポインタ操作、そしてステージ（画像＋SVG）の描画を担当する。
// 型・定数はeditor/model、書き出しはeditor/raster、ツールバーはeditor/Toolbarへ分離している。
// Quick editor: every annotation stays a re-editable object until export. This file owns the
// state, the pointer interactions, and the stage (image + SVG overlay). Types and constants live
// in editor/model, the export path in editor/raster, and the toolbar in editor/Toolbar.

function Editor() {
  const [version, setVersion] = useState(0);
  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(null);
  const [objects, setObjects] = useState<Obj[]>([]);
  const [crop, setCrop] = useState<RectShape | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>("select");
  const [color, setColor] = useState(COLORS[0]);
  // テキスト吹き出しの文字色（白/黒の2択） / Text-bubble font color (white or black only)
  const [textColor, setTextColor] = useState("#ffffff");
  // 線幅の倍率（細0.6 / 中1.0 / 太1.7）。基準線幅に掛けて全体へ反映
  // Line-width multiplier (thin/medium/thick); multiplied into the base stroke globally
  const [strokeMul, setStrokeMul] = useState(1);
  // ハイライトの不透明度（0〜1）。新規作成時の既定値であり、スライダーで0〜100%として編集する
  // Highlight opacity (0-1). Default for new highlights; edited as 0-100% via the slider
  const [highlightOpacity, setHighlightOpacity] = useState(0.45);
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
  const metrics = computeMetrics(imgSize?.w ?? null, strokeMul);
  const { stroke, fontSize, badgeR, blurPx } = metrics;

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
        const winScale = await win.scaleFactor();
        const outer = await win.outerSize();
        const chromeW = outer.width / winScale - window.innerWidth;
        const maxInner = window.screen.availWidth * 0.96 - chromeW;
        const targetInner = Math.min(needed, maxInner);
        const outerH = outer.height / winScale; // 高さは維持 / keep height
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

  const renderToPng = useCallback(
    async (format: "png" | "jpg" | "webp" = "png"): Promise<Uint8Array | null> => {
      const img = imgRef.current;
      if (!img || !imgSize) return null;
      return rasterize({ img, size: imgSize, objects, crop, metrics, format });
    },
    // metricsは毎レンダー新しいオブジェクトになるため、依存には中身の値を並べる
    // metrics is a fresh object each render, so depend on its values rather than the object
    [objects, crop, imgSize, stroke, fontSize, badgeR, blurPx], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const showToast = useCallback((message: string, ms = 1800) => {
    setToast(message);
    setTimeout(() => setToast(null), ms);
  }, []);

  const doCopy = useCallback(async () => {
    const png = await renderToPng();
    if (!png) return;
    try {
      await invoke("export_copy", png);
      showToast("コピーしました");
    } catch (e) {
      showToast(`コピーに失敗しました: ${e}`);
      invoke("frontend_log", { message: `export_copy failed: ${e}` });
    }
  }, [renderToPng, showToast]);

  const doSave = useCallback(async () => {
    // 保存形式は設定に従う（フロントのエンコードとバックエンドの拡張子を一致させる）
    // The save format follows settings so the encoding here matches the backend's extension
    let format: "png" | "jpg" | "webp" = "png";
    try {
      const s = await invoke<{ saveFormat: string }>("get_settings");
      const f = (s.saveFormat || "png").toLowerCase();
      format = f === "jpg" || f === "jpeg" ? "jpg" : f === "webp" ? "webp" : "png";
    } catch {
      /* 設定が読めなければPNG / Fall back to PNG when settings are unreadable */
    }
    const bytes = await renderToPng(format);
    if (!bytes) return;
    try {
      await invoke("export_save", bytes);
    } catch (e) {
      showToast(`保存に失敗しました: ${e}`);
      invoke("frontend_log", { message: `export_save failed: ${e}` });
    }
  }, [renderToPng, showToast]);

  const doPin = useCallback(async () => {
    const png = await renderToPng();
    if (!png) return;
    try {
      await invoke("pin_image", png);
      showToast("デスクトップに貼り付けました");
    } catch (e) {
      showToast(`ピン留めに失敗しました: ${e}`);
      invoke("frontend_log", { message: `pin_image failed: ${e}` });
    }
  }, [renderToPng, showToast]);

  // Smart Redact: ローカルOCRで機密領域を検出し、ぼかしオブジェクトとして追加する
  // Smart Redact: detect sensitive regions with local OCR and add them as blur objects
  const runRedact = useCallback(async () => {
    if (redacting) return;
    setRedacting(true);
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

  // Screenshot-to-Code: 編集後の画像から単一HTMLを生成する（ローカルOllamaのみ）
  // キャプチャ画像は機密を含みうるため、外部APIへは一切送らない方針。
  // Screenshot-to-Code: generate a single-file HTML from the edited image (local Ollama only).
  // Captures can contain sensitive material, so nothing is ever sent to an external API.
  const runCodegen = useCallback(async () => {
    if (generating) return;
    try {
      const settings = await invoke<{ ollamaUrl: string; ollamaModel: string }>("get_settings");
      const ollamaModel = settings.ollamaModel?.trim();
      if (!ollamaModel) {
        showToast("メイン画面でOllamaのモデル名を設定してください");
        return;
      }
      const png = await renderToPng();
      if (!png) return;
      setGenerating(true);
      invoke("frontend_log", { message: `codegen start: model=${ollamaModel}` });

      // 送信サイズを抑えるため縮小＋JPEG化する / Downscale and JPEG-encode to keep the payload small
      const bitmap = await createImageBitmap(new Blob([png as BlobPart], { type: "image/png" }));
      // 長辺の上限。これ以上大きくてもモデルの認識精度は上がらず、転送と推論だけ重くなる
      // Long-edge cap: beyond this the model gains no accuracy, only transfer and inference cost
      const MAX_EDGE = 2048;
      const k = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
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

      // OllamaネイティブAPI。Rust経由で呼ぶ（WebViewのfetchはCORSで弾かれる。完全ローカル・無料、要: ビジョン対応モデル）
      // Ollama's native API via Rust (WebView fetch is blocked by CORS); fully local & free, needs a vision-capable model
      let code = await invoke<string>("ollama_generate", {
        url: settings.ollamaUrl?.trim() || "http://127.0.0.1:11434",
        model: ollamaModel,
        prompt,
        imageBase64: base64,
      });

      // コードフェンス付きで返ってきた場合は剥がす / Strip code fences if present
      code = code.replace(/^```[a-z]*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
      setResultModal({ title: "生成されたHTML（Tailwind CSS）", text: code || "（出力が空でした）" });
    } catch (e) {
      // タイムアウト（Rust側で10分）もここに来る / Timeouts (10 min, enforced in Rust) land here too
      showToast(`コード生成に失敗しました: ${String(e).slice(0, 160)}`, 6000);
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
      // macOSはCmd（metaKey）、Windows/LinuxはCtrlが修飾キーの慣例のため両方を受け付ける
      // macOS uses Cmd (metaKey), Windows/Linux use Ctrl; accept either as the modifier
      const mod = e.ctrlKey || e.metaKey;
      if (e.key === "Escape") setSelected(null);
      if ((e.key === "Delete" || e.key === "Backspace") && selected) {
        pushUndo();
        setObjects((os) => os.filter((o) => o.id !== selected));
        setSelected(null);
      }
      if (mod && e.key.toLowerCase() === "z") undo();
      if (mod && e.key.toLowerCase() === "c") doCopy();
      if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        doSave();
      }
      // 表示ズーム / Display zoom
      if (mod && (e.key === "+" || e.key === "=" || e.key === ";")) {
        e.preventDefault();
        stepZoom(1);
      }
      if (mod && e.key === "-") {
        e.preventDefault();
        stepZoom(-1);
      }
      if (mod && e.key === "0") {
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
        setObjects((os) => [...os, { id: nextId(), kind: "text", x: te.x, y: te.y, text: value, color, textColor }]);
      }
      return null;
    });
  }, [color, textColor, pushUndo]);

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

    // テキストツールは常にここで新規作成し、ポインタ捕捉はしない。またpreventDefault()で
    // 「フォーカス不可な要素へのmousedownは既存フォーカスを外す」というブラウザの既定動作を
    // 抑止する。抑止しないと、新規<textarea>へautoFocusした直後にこの既定動作が働いて
    // 即blur→空のまま確定・消去されてしまう。
    // The text tool always creates a new box here, without capturing the pointer, and calls
    // preventDefault() to suppress the browser's default "mousedown on a non-focusable element
    // blurs the current focus" behavior. Without this, that default action fires right after
    // the new <textarea> gets autoFocus, immediately blurring it and committing the (empty)
    // text before the user can type.
    if (tool === "text") {
      e.preventDefault();
      setSelected(null);
      setTextEdit({ id: null, x: p.x, y: p.y, value: "" });
      return;
    }

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
          tool === "blur"
            ? { ...base, kind: "blur" }
            : tool === "highlight"
              ? { ...base, kind: "highlight", color, opacity: highlightOpacity }
              : { ...base, kind: tool, color },
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

  // ハイライトの不透明度を選ぶ（0〜1）。選択中のハイライトがあればその不透明度も変更する
  // Pick highlight opacity (0-1); also update the selected highlight's opacity if any
  const chooseHighlightOpacity = (v: number) => {
    setHighlightOpacity(v);
    if (selected) {
      pushUndo();
      setObjects((os) =>
        os.map((o) => (o.id === selected && o.kind === "highlight" ? { ...o, opacity: v } : o)),
      );
    }
  };

  // テキストの文字色（白/黒）を選ぶ。選択中のテキストがあればその文字色も変更する
  // Pick the text font color (white/black); also update the selected text's color if any
  const chooseTextColor = (v: string) => {
    setTextColor(v);
    if (selected) {
      pushUndo();
      setObjects((os) => os.map((o) => (o.id === selected && o.kind === "text" ? { ...o, textColor: v } : o)));
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

  return (
    <div className="flex h-screen w-screen flex-col bg-zinc-900 text-zinc-100">
      <Toolbar
        toolbarRef={toolbarRef}
        tool={tool}
        onSelectTool={(t) => {
          setTool(t);
          setSelected(null);
        }}
        hasCrop={crop !== null}
        onClearCrop={() => {
          pushUndo();
          setCrop(null);
        }}
        strokeMul={strokeMul}
        onStrokeMul={setStrokeMul}
        color={color}
        onColor={chooseColor}
        onEyeDropper={pickWithEyeDropper}
        selectedObj={selectedObj}
        highlightOpacity={highlightOpacity}
        onHighlightOpacity={chooseHighlightOpacity}
        textColor={textColor}
        onTextColor={chooseTextColor}
        redacting={redacting}
        onRedact={runRedact}
        extracting={extracting}
        onExtractText={runExtractText}
        generating={generating}
        genElapsed={genElapsed}
        onCodegen={runCodegen}
        scale={scale}
        zoom={zoom}
        onZoomStep={stepZoom}
        onZoomFit={() => setZoom(null)}
        onPin={doPin}
        onCopy={doCopy}
        onSave={doSave}
      />

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
            src={`${convertFileSrc("current", "edit")}?v=${version}`}
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
                      <rect key={o.id} {...common} x={o.x} y={o.y} width={o.w} height={o.h} fill={o.color} fillOpacity={o.opacity} />
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
                  if (o.kind === "text") {
                    const lines = o.text.split("\n");
                    const { width, height, ascent, lineHeight } = measureTextLines(lines, fontSize);
                    const { padding, radius } = textBubbleMetrics(fontSize);
                    return (
                      <g key={o.id}>
                        <rect
                          {...common}
                          x={o.x - padding}
                          y={o.y - padding}
                          width={width + padding * 2}
                          height={height + padding * 2}
                          rx={radius}
                          ry={radius}
                          fill={o.color}
                        />
                        {/* ascentで実測ベースにベースラインを合わせる（フォントごとの上端の
                            見え方が違ってもボックスからはみ出さないようにするため） */}
                        {/* Baseline placed via the measured ascent, so text stays inside the
                            box regardless of how a given font's top metrics render */}
                        <text
                          {...common}
                          x={o.x}
                          y={o.y + ascent}
                          fill={o.textColor}
                          fontSize={fontSize}
                          fontWeight="bold"
                          fontFamily={TEXT_FONT}
                        >
                          {lines.map((line, i) => (
                            // SVGのヒットテストは親<text>ではなく子<tspan>を対象にすることがあるため
                            // data-objをtspanにも付与する（付けないと選択・移動できない）
                            // SVG hit-testing often targets the child <tspan> rather than the parent
                            // <text>, so data-obj must be set on the tspan too (otherwise select/move breaks)
                            <tspan key={i} data-obj={o.id} x={o.x} dy={i === 0 ? 0 : lineHeight}>
                              {line}
                            </tspan>
                          ))}
                        </text>
                      </g>
                    );
                  }
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
                  className="absolute resize-none border-2 border-[var(--accent)] outline-none"
                  style={{
                    left: textEdit.x * scale - textBubbleMetrics(fontSize).padding * scale,
                    top: textEdit.y * scale - textBubbleMetrics(fontSize).padding * scale,
                    minWidth: 160,
                    backgroundColor: color,
                    color: textColor,
                    borderRadius: textBubbleMetrics(fontSize).radius * scale,
                    padding: textBubbleMetrics(fontSize).padding * scale,
                    fontSize: Math.max(12, fontSize * scale),
                    // 確定後のSVG（ascentベースの実測配置）と行送りを揃える。line-heightの
                    // 既定の余分な行間（half-leading）が入ると、確定前後で数pxズレて見えるため
                    // Match the SVG's ascent-based line spacing so the box doesn't visibly
                    // jump by a few px when the text commits (default line-height half-leading
                    // would otherwise add a mismatched gap above the first line)
                    lineHeight: `${measureTextLines(textEdit.value.split("\n"), fontSize).lineHeight * scale}px`,
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

      {resultModal !== null && (
        <ResultModal
          // 内容が変わったらtextareaを作り直す（defaultValueは初回しか反映されないため）
          // Remount the textarea when the content changes (defaultValue only applies on mount)
          key={`${resultModal.title}:${resultModal.text.length}`}
          title={resultModal.title}
          text={resultModal.text}
          onCopied={(partial) => showToast(partial ? "選択範囲をコピーしました" : "コピーしました")}
          onClose={() => setResultModal(null)}
        />
      )}
    </div>
  );
}

export default Editor;
