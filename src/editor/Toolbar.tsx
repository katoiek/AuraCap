import { invoke } from "@tauri-apps/api/core";
import ToolIcon from "./ToolIcon";
import { COLORS, STROKE_PRESETS, TOOLS, type Obj, type Tool } from "./model";

// エディタのツールバー。状態は一切持たず、親から受け取った値と操作を並べるだけの表示層。
// 状態を持たせないのは、取り消し（undo）や選択の一貫性を親が一箇所で管理しているため。
// The editor toolbar: a presentation layer with no state of its own — it renders the values and
// actions handed down by the parent, which owns undo and selection consistency in one place.

export type ToolbarProps = {
  toolbarRef: React.RefObject<HTMLElement | null>;
  tool: Tool;
  onSelectTool: (tool: Tool) => void;
  hasCrop: boolean;
  onClearCrop: () => void;
  strokeMul: number;
  onStrokeMul: (mul: number) => void;
  color: string;
  onColor: (color: string) => void;
  onEyeDropper: () => void;
  selectedObj: Obj | null;
  highlightOpacity: number;
  onHighlightOpacity: (opacity: number) => void;
  textColor: string;
  onTextColor: (color: string) => void;
  extracting: boolean;
  onExtractText: () => void;
  generating: boolean;
  genElapsed: number;
  onCodegen: () => void;
  codegenEnabled: boolean;
  scale: number;
  zoom: number | null;
  onZoomStep: (dir: 1 | -1) => void;
  onZoomFit: () => void;
  onPin: () => void;
  onCopy: () => void;
  onSave: () => void;
};

function Toolbar(p: ToolbarProps) {
  // ハイライト・テキストの詳細設定は「そのツールを使用中」か「その種類を選択中」のときだけ出す
  // Per-tool controls appear only while that tool is active or an object of that kind is selected
  const showOpacity = p.tool === "highlight" || p.selectedObj?.kind === "highlight";
  const showTextColor = p.tool === "text" || p.selectedObj?.kind === "text";
  const opacity =
    p.selectedObj?.kind === "highlight" ? p.selectedObj.opacity : p.highlightOpacity;
  const activeTextColor =
    p.selectedObj?.kind === "text" ? p.selectedObj.textColor : p.textColor;

  return (
    <header
      ref={p.toolbarRef}
      className="flex items-center gap-1 overflow-x-auto border-b border-zinc-800 px-2 py-1.5 [&>*]:shrink-0"
    >
      {TOOLS.map((t) => (
        <button
          key={t.tool}
          title={t.label}
          onClick={() => p.onSelectTool(t.tool)}
          className={`grid h-9 w-9 place-items-center rounded-lg transition-colors ${
            p.tool === t.tool ? "bg-[var(--accent)] text-zinc-900" : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
          }`}
        >
          <ToolIcon tool={t.tool} />
        </button>
      ))}
      {p.hasCrop && (
        <button
          onClick={p.onClearCrop}
          className="ml-1 rounded-lg bg-zinc-800 px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700"
        >
          トリミング解除
        </button>
      )}
      <div className="mx-2 h-6 w-px bg-zinc-700" />
      {/* 線幅プリセット / Line-width presets */}
      {STROKE_PRESETS.map((s) => (
        <button
          key={s.label}
          title={s.title}
          onClick={() => p.onStrokeMul(s.mul)}
          className={`grid h-9 w-9 place-items-center rounded-lg text-xs transition-colors ${
            p.strokeMul === s.mul ? "bg-[var(--accent)] text-zinc-900" : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
          }`}
        >
          {s.label}
        </button>
      ))}
      <div className="mx-2 h-6 w-px bg-zinc-700" />
      {COLORS.map((c) => (
        <button
          key={c}
          onClick={() => p.onColor(c)}
          className={`h-6 w-6 rounded-full border-2 ${p.color === c ? "border-white" : "border-zinc-600"}`}
          style={{ backgroundColor: c }}
        />
      ))}
      {/* 自由色（カラーピッカー） / Custom color picker */}
      <label
        title="自由な色を選ぶ"
        className={`relative grid h-6 w-6 cursor-pointer place-items-center overflow-hidden rounded-full border-2 ${
          COLORS.includes(p.color) ? "border-zinc-600" : "border-white"
        }`}
        style={{ backgroundColor: COLORS.includes(p.color) ? "transparent" : p.color }}
      >
        {COLORS.includes(p.color) && <span className="text-[11px] leading-none">🎨</span>}
        <input
          type="color"
          value={p.color}
          onChange={(e) => p.onColor(e.target.value)}
          className="absolute inset-0 cursor-pointer opacity-0"
        />
      </label>
      {/* スポイト / Eyedropper */}
      <button
        onClick={p.onEyeDropper}
        title="画面から色を吸い取る（スポイト）"
        className="grid h-9 w-9 place-items-center rounded-lg bg-zinc-800 text-base text-zinc-300 hover:bg-zinc-700"
      >
        🧪
      </button>
      {showOpacity && (
        <label
          className="flex items-center gap-1.5 rounded-lg bg-zinc-800 px-2.5 py-1.5 text-xs text-zinc-300"
          title="ハイライトの不透明度"
        >
          <span>不透明度</span>
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round(opacity * 100)}
            onChange={(e) => p.onHighlightOpacity(Number(e.target.value) / 100)}
            className="w-20 accent-[var(--accent)]"
          />
          <span className="w-8 text-right font-mono">{Math.round(opacity * 100)}%</span>
        </label>
      )}
      {/* テキストの文字色（白/黒）。カラースウォッチは背景色として使う */}
      {/* Text font color (white/black); the color swatches act as the background */}
      {showTextColor && (
        <div className="flex items-center gap-1.5 rounded-lg bg-zinc-800 px-2.5 py-1.5 text-xs text-zinc-300">
          <span>文字色</span>
          {["#ffffff", "#000000"].map((c) => (
            <button
              key={c}
              title={c === "#ffffff" ? "白文字" : "黒文字"}
              onClick={() => p.onTextColor(c)}
              className={`h-6 w-6 rounded-full border-2 ${
                activeTextColor === c ? "border-[var(--accent)]" : "border-zinc-600"
              }`}
              style={{ backgroundColor: c }}
            />
          ))}
        </div>
      )}
      <div className="mx-2 h-6 w-px bg-zinc-700" />
      {/* テキスト抽出（ローカルOCR） / Text extraction (local OCR) */}
      <button
        onClick={p.onExtractText}
        disabled={p.extracting}
        title="画像内の文字をOCRで読み取ってコピーできます（ローカル処理、外部送信なし）"
        className="rounded-lg bg-zinc-800 px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700 disabled:opacity-50"
      >
        {p.extracting ? "抽出中…" : "📋 テキスト抽出"}
      </button>
      {/* Screenshot-to-Code（ローカルOllama）。メイン画面の設定でOFFなら出さない */}
      {/* Screenshot-to-Code (local Ollama); hidden when turned OFF in the main window settings */}
      {p.codegenEnabled && (
        <button
          onClick={p.onCodegen}
          disabled={p.generating}
          title="このスクリーンショットからTailwind CSSのHTMLを生成します（ローカルのOllamaで処理、外部送信なし）"
          className="rounded-lg bg-zinc-800 px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700 disabled:opacity-50"
        >
          {p.generating ? `生成中… ${p.genElapsed}s` : "⧉ コード生成"}
        </button>
      )}
      <div className="mx-2 h-6 w-px bg-zinc-700" />
      {/* 表示ズーム / Display zoom */}
      <button
        onClick={() => p.onZoomStep(-1)}
        title="ズームアウト (Ctrl+-)"
        className="grid h-8 w-8 place-items-center rounded-lg bg-zinc-800 text-base text-zinc-300 hover:bg-zinc-700"
      >
        −
      </button>
      <button
        onClick={p.onZoomFit}
        title="ウィンドウに合わせる (Ctrl+0)"
        className={`min-w-14 rounded-lg px-2 py-1.5 text-center font-mono text-xs hover:bg-zinc-700 ${
          p.zoom === null ? "bg-zinc-800 text-zinc-400" : "bg-zinc-700 text-[var(--accent)]"
        }`}
      >
        {Math.round(p.scale * 100)}%
      </button>
      <button
        onClick={() => p.onZoomStep(1)}
        title="ズームイン (Ctrl++ / Ctrl+ホイール)"
        className="grid h-8 w-8 place-items-center rounded-lg bg-zinc-800 text-base text-zinc-300 hover:bg-zinc-700"
      >
        ＋
      </button>
      <div className="ml-auto flex items-center gap-1.5">
        <button
          onClick={p.onPin}
          className="rounded-lg bg-zinc-800 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-700"
          title="デスクトップに常に最前面で貼り付け"
        >
          📌 ピン
        </button>
        <button
          onClick={p.onCopy}
          className="rounded-lg bg-[var(--accent)] px-3.5 py-1.5 text-sm font-semibold text-zinc-900 hover:bg-[var(--accent-strong)]"
          title="Ctrl+C"
        >
          コピー
        </button>
        <button
          onClick={p.onSave}
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
  );
}

export default Toolbar;
