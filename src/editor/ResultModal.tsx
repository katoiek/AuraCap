import { useRef } from "react";

// コード生成・テキスト抽出の結果を出すモーダル。
// textareaにしているのは、生成物の一部だけを選んでコピーしたい場面が多いため。
// Modal for codegen / text-extraction output. It uses a textarea because partial
// selection-and-copy is the common case for generated results.

export type ResultModalProps = {
  title: string;
  text: string;
  onCopied: (partial: boolean) => void;
  onClose: () => void;
};

function ResultModal({ title, text, onCopied, onClose }: ResultModalProps) {
  const textRef = useRef<HTMLTextAreaElement | null>(null);

  const copy = () => {
    // 選択範囲があればそれを、なければ全文をコピー
    // Copy the selection if any, otherwise the whole text
    const ta = textRef.current;
    const sel = ta ? ta.value.substring(ta.selectionStart, ta.selectionEnd) : "";
    navigator.clipboard.writeText(sel || ta?.value || text);
    onCopied(Boolean(sel));
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-6">
      <div className="flex h-[80vh] max-h-full w-full max-w-3xl flex-col rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl">
        <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-2.5">
          <h2 className="text-sm font-semibold">{title}</h2>
          <div className="flex gap-1.5">
            <button
              onClick={copy}
              className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-zinc-900 hover:bg-[var(--accent-strong)]"
            >
              コピー
            </button>
            <button
              onClick={onClose}
              className="rounded-lg bg-zinc-800 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700"
            >
              閉じる
            </button>
          </div>
        </div>
        {/* 編集・選択できるテキストエリア（部分選択コピー用） / Editable, selectable area for partial-copy */}
        <textarea
          ref={textRef}
          defaultValue={text}
          spellCheck={false}
          className="min-h-0 flex-1 resize-none overflow-auto bg-transparent p-4 font-mono text-xs leading-relaxed text-zinc-300 focus:outline-none"
        />
      </div>
    </div>
  );
}

export default ResultModal;
