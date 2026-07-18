import { useStore, INTERVAL_OPTIONS_MS, WINDOW_OPTIONS_MIN } from "../state/store";

const THRESHOLD_OPTIONS_MS = [50, 100, 150, 200];

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex items-center gap-2">
      <span className="text-[0.68rem] uppercase tracking-[0.12em] text-ink-3">{label}</span>
      {children}
    </label>
  );
}

export default function ControlBar() {
  const running = useStore((s) => s.running);
  const intervalMs = useStore((s) => s.intervalMs);
  const windowMin = useStore((s) => s.windowMin);
  const spikeThresholdMs = useStore((s) => s.spikeThresholdMs);
  const startedUtcMs = useStore((s) => s.startedUtcMs);
  const { start, stop, clearData, setIntervalMs, setWindowMin, setSpikeThresholdMs, exportCurrent, importFile } =
    useStore.getState();

  return (
    <div className="card card-enter flex flex-wrap items-center gap-x-5 gap-y-3 px-4 py-3">
      <button
        onClick={() => (running ? stop() : start())}
        className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-colors ${
          running
            ? "bg-bad/15 text-bad hover:bg-bad/25"
            : "bg-accent text-white hover:bg-accent-bright"
        }`}
      >
        {running ? (
          <>
            <span className="recording-dot size-2 rounded-full bg-bad" /> Stop
          </>
        ) : (
          <>
            <svg width="10" height="12" viewBox="0 0 10 12" fill="currentColor">
              <path d="M0 0l10 6-10 6z" />
            </svg>
            Start
          </>
        )}
      </button>

      <Field label="Rate">
        <select value={intervalMs} onChange={(e) => setIntervalMs(Number(e.target.value))}>
          {INTERVAL_OPTIONS_MS.map((ms) => (
            <option key={ms} value={ms}>
              {ms < 1000 ? `${1000 / ms}/s` : `every ${ms / 1000}s`}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Window">
        <select value={windowMin} onChange={(e) => setWindowMin(Number(e.target.value))}>
          {WINDOW_OPTIONS_MIN.map((min) => (
            <option key={min} value={min}>
              {min >= 60 ? `${min / 60} h` : `${min} min`}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Spike >">
        <select value={spikeThresholdMs} onChange={(e) => setSpikeThresholdMs(Number(e.target.value))}>
          {THRESHOLD_OPTIONS_MS.map((ms) => (
            <option key={ms} value={ms}>
              {ms} ms
            </option>
          ))}
        </select>
      </Field>

      <div className="ml-auto flex items-center gap-2">
        <button
          onClick={() => exportCurrent()}
          disabled={startedUtcMs === null}
          className="rounded-lg border border-line-2 px-3 py-1.5 text-xs text-ink-2 transition-colors hover:border-accent hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
        >
          Export session
        </button>
        <button
          onClick={() => importFile()}
          className="rounded-lg border border-line-2 px-3 py-1.5 text-xs text-ink-2 transition-colors hover:border-accent hover:text-ink"
        >
          Import…
        </button>
        <button
          onClick={() => clearData()}
          disabled={startedUtcMs === null || running}
          className="rounded-lg border border-line-2 px-3 py-1.5 text-xs text-ink-2 transition-colors hover:border-bad hover:text-bad disabled:cursor-not-allowed disabled:opacity-40"
          title={running ? "Stop monitoring first" : "Discard all recorded samples"}
        >
          Clear
        </button>
      </div>
    </div>
  );
}
