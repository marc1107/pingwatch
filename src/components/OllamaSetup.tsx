import { useState } from "react";
import { getIpc, type OllamaPullProgress } from "../lib/ipc";
import { RECOMMENDED_MODELS } from "../lib/localAi";
import { useStore } from "../state/store";

const PRIMARY_BTN =
  "rounded-lg bg-accent px-4 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-accent-bright disabled:cursor-not-allowed disabled:opacity-40";
const SECONDARY_BTN =
  "rounded-lg border border-line-2 px-3 py-1.5 text-xs text-ink-2 transition-colors hover:border-accent hover:text-ink disabled:cursor-not-allowed disabled:opacity-40";

function ProgressBar({ progress }: { progress: OllamaPullProgress }) {
  const pct =
    progress.completed !== null && progress.total !== null && progress.total > 0
      ? Math.min(100, Math.round((progress.completed / progress.total) * 100))
      : null;
  return (
    <div className="mt-1.5">
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-3">
        {pct === null ? (
          <div className="h-full w-1/3 animate-pulse rounded-full bg-accent" />
        ) : (
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-300"
            style={{ width: `${pct}%` }}
          />
        )}
      </div>
      <div className="mt-1 font-mono text-[0.66rem] text-ink-3">
        {progress.status}
        {pct !== null && ` · ${pct}%`}
      </div>
    </div>
  );
}

interface ModelRowProps {
  name: string;
  note: string;
  disabled: boolean;
  onStart: () => void;
  onDone: () => void;
}

function ModelRow({ name, note, disabled, onStart, onDone }: ModelRowProps) {
  const [progress, setProgress] = useState<OllamaPullProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pulling, setPulling] = useState(false);
  const refreshOllama = useStore((s) => s.refreshOllama);

  async function download() {
    setError(null);
    setPulling(true);
    onStart();
    try {
      const ipc = await getIpc();
      await ipc.ollamaPull(name, (p) => setProgress(p));
      await refreshOllama();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setPulling(false);
      onDone();
    }
  }

  return (
    <div className="flex flex-col gap-1 border-t border-line/60 py-2 first:border-0 first:pt-0">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="font-mono text-[0.78rem]">{name}</div>
          <div className="text-[0.7rem] text-ink-3">{note}</div>
        </div>
        <button onClick={() => void download()} disabled={pulling || disabled} className={SECONDARY_BTN}>
          {pulling ? "Downloading…" : "Download"}
        </button>
      </div>
      {pulling && progress && <ProgressBar progress={progress} />}
      {error && <div className="text-[0.7rem] text-bad">{error}</div>}
    </div>
  );
}

/**
 * Renders whichever "local AI is not ready" state applies: Ollama not
 * installed, installed but not running, or reachable with no usable model.
 * The AnalysisPanel is responsible for the "ready" state and does not render
 * this component then.
 */
export default function OllamaSetup() {
  const ollama = useStore((s) => s.ollama);
  const refreshOllama = useStore((s) => s.refreshOllama);
  const [pullingModel, setPullingModel] = useState<string | null>(null);

  if (ollama === null) {
    return <p className="text-[0.78rem] text-ink-2">Checking local AI…</p>;
  }

  if (!ollama.binaryInstalled) {
    return (
      <div className="space-y-2">
        <p className="text-[0.78rem] leading-relaxed text-ink-2">
          Local AI runs on Ollama, a free app that hosts models on this machine — no data leaves
          your computer.
        </p>
        <div className="flex gap-2">
          <button
            onClick={() => void getIpc().then((ipc) => ipc.openExternal("https://ollama.com/download"))}
            className={PRIMARY_BTN}
          >
            Get Ollama
          </button>
          <button onClick={() => void refreshOllama()} className={SECONDARY_BTN}>
            Recheck
          </button>
        </div>
      </div>
    );
  }

  if (!ollama.reachable) {
    return (
      <div className="space-y-2">
        <p className="text-[0.78rem] leading-relaxed text-ink-2">
          Ollama is installed but not running. Start the Ollama app, then recheck.
        </p>
        <button onClick={() => void refreshOllama()} className={SECONDARY_BTN}>
          Recheck
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <p className="text-[0.78rem] leading-relaxed text-ink-2">
        No local model installed yet. Download one to run analysis on this machine.
      </p>
      <div>
        {RECOMMENDED_MODELS.map((m) => (
          <ModelRow
            key={m.name}
            name={m.name}
            note={m.note}
            disabled={pullingModel !== null && pullingModel !== m.name}
            onStart={() => setPullingModel(m.name)}
            onDone={() => setPullingModel(null)}
          />
        ))}
      </div>
    </div>
  );
}
