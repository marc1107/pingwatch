import { useEffect } from "react";
import { useStore } from "./state/store";
import Dashboard from "./components/Dashboard";
import CompareView from "./components/CompareView";

function Logo() {
  return (
    <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden>
      <rect x="1" y="1" width="24" height="24" rx="7" fill="var(--color-surface-3)" stroke="var(--color-line-2)" />
      <path
        d="M4 16.5h4l2-2.5 2.5 3.5 2-9 2.5 8 1.5-2h3.5"
        fill="none"
        stroke="var(--color-accent-bright)"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default function App() {
  const view = useStore((s) => s.view);
  const running = useStore((s) => s.running);
  const error = useStore((s) => s.error);
  const connectionLabel = useStore((s) => s.connectionLabel);
  const importedCount = useStore((s) => s.importedSessions.length);
  const { init, setView, setConnectionLabel, setError } = useStore.getState();

  useEffect(() => {
    void init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="relative z-10 mx-auto flex h-full max-w-[1500px] flex-col px-5 pb-5">
      <header className="flex items-center gap-5 py-4">
        <div className="flex items-center gap-2.5">
          <Logo />
          <h1 className="font-display text-lg font-bold tracking-tight">
            Ping<span className="text-accent-bright">Watch</span>
          </h1>
          {running && (
            <span className="flex items-center gap-1.5 rounded-full bg-bad/10 px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-wider text-bad">
              <span className="recording-dot size-1.5 rounded-full bg-bad" /> rec
            </span>
          )}
        </div>

        <nav className="flex rounded-lg border border-line bg-surface p-0.5 text-[0.78rem]">
          {(["live", "compare"] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`rounded-md px-3.5 py-1 font-medium capitalize transition-colors ${
                view === v ? "bg-surface-3 text-ink" : "text-ink-3 hover:text-ink-2"
              }`}
            >
              {v}
              {v === "compare" && importedCount > 0 && (
                <span className="ml-1.5 rounded-full bg-accent/20 px-1.5 text-[0.62rem] font-mono text-accent-bright">
                  {importedCount}
                </span>
              )}
            </button>
          ))}
        </nav>

        <label className="ml-auto flex items-center gap-2">
          <span className="text-[0.68rem] uppercase tracking-[0.12em] text-ink-3">This device</span>
          <input
            type="text"
            value={connectionLabel}
            onChange={(e) => setConnectionLabel(e.target.value)}
            placeholder='e.g. "Laptop Wi-Fi"'
            className="w-40"
            title="Label stored in exported sessions so you can tell machines apart"
          />
        </label>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto pb-2">
        {view === "live" ? <Dashboard /> : <CompareView />}
      </main>

      {error && (
        <div className="fixed bottom-5 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-xl border border-bad/40 bg-surface-2 px-4 py-2.5 text-sm text-ink shadow-2xl">
          <span className="size-2 shrink-0 rounded-full bg-bad" />
          <span className="max-w-md">{error}</span>
          <button onClick={() => setError(null)} className="text-ink-3 hover:text-ink" title="Dismiss">
            ✕
          </button>
        </div>
      )}
    </div>
  );
}
