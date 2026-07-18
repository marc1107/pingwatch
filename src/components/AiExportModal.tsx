import { useEffect, useRef, useState } from "react";

interface AiExportModalProps {
  text: string;
  onClose: () => void;
}

export default function AiExportModal({ text, onClose }: AiExportModalProps) {
  const [copyLabel, setCopyLabel] = useState("Copy to clipboard");
  const preRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  async function copy() {
    let copied = false;
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
    } catch {
      // Async clipboard can be unavailable (e.g. some webviews); fall back
      // to a hidden textarea + execCommand, which still works there.
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        copied = document.execCommand("copy");
      } finally {
        ta.remove();
      }
    }
    if (copied) {
      setCopyLabel("Copied ✓");
    } else {
      if (preRef.current) {
        const range = document.createRange();
        range.selectNodeContents(preRef.current);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
      setCopyLabel("Press ⌘/Ctrl+C");
    }
    setTimeout(() => setCopyLabel("Copy to clipboard"), 2000);
  }

  const kb = text.length / 1024;
  const kTokens = text.length / 4 / 1000;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="card flex max-h-[85vh] w-full max-w-3xl flex-col p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-4">
          <h2 className="font-display text-lg font-semibold">Export for AI analysis</h2>
          <button
            onClick={onClose}
            className="rounded-lg border border-line-2 px-2 py-1 text-xs text-ink-3 transition-colors hover:border-bad hover:text-bad"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <p className="mt-1.5 text-[0.78rem] leading-relaxed text-ink-2">
          Copy this and paste it into an AI chat (e.g. Claude or ChatGPT). The prompt instructs
          the model to build a self-contained HTML report comparing both sessions.
        </p>

        <pre
          ref={preRef}
          className="mt-3 flex-1 overflow-y-auto whitespace-pre-wrap rounded-lg border border-line-2 bg-surface-3/60 p-3 font-mono text-[0.68rem] leading-relaxed text-ink-2"
        >
          {text}
        </pre>

        <div className="mt-3 flex items-center gap-3">
          <span className="font-mono text-[0.68rem] text-ink-3">
            ~{kb.toFixed(0)} KB · ~{kTokens.toFixed(1)} k tokens
          </span>
          <div className="ml-auto flex gap-2">
            <button
              onClick={() => void copy()}
              className="rounded-lg bg-accent px-4 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-accent-bright"
            >
              {copyLabel}
            </button>
            <button
              onClick={onClose}
              className="rounded-lg border border-line-2 px-3 py-1.5 text-xs text-ink-2 transition-colors hover:border-accent hover:text-ink"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
