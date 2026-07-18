import { useEffect, useRef, useState } from "react";
import { useStore } from "./state/store";
import Dashboard from "./components/Dashboard";
import CompareView from "./components/CompareView";
import UpdateBanner from "./components/UpdateBanner";

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

function SettingsPopover() {
  const autoUpdateEnabled = useStore((s) => s.autoUpdateEnabled);
  const { setAutoUpdateEnabled } = useStore.getState();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        title="Settings"
        className="flex size-7 items-center justify-center rounded-lg text-ink-3 transition-colors hover:text-ink"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 15a3 3 0 100-6 3 3 0 000 6z"
          />
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09a1.65 1.65 0 00-1.08-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09a1.65 1.65 0 001.51-1.08 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z"
          />
        </svg>
      </button>
      {open && (
        <div className="absolute right-0 top-9 z-20 w-56 rounded-lg border border-line-2 bg-surface-2 p-3 shadow-2xl">
          <label className="flex items-start gap-2 text-[0.78rem] text-ink-2">
            <input
              type="checkbox"
              checked={autoUpdateEnabled}
              onChange={(e) => setAutoUpdateEnabled(e.target.checked)}
              className="mt-0.5"
            />
            <span>Check for updates automatically</span>
          </label>
        </div>
      )}
    </div>
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

        <SettingsPopover />
      </header>

      <UpdateBanner />

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
