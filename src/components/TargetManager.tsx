import { useState } from "react";
import { useStore } from "../state/store";
import { colorForIndex } from "../lib/format";

export default function TargetManager() {
  const targets = useStore((s) => s.targets);
  const { addTarget, removeTarget } = useStore.getState();
  const [label, setLabel] = useState("");
  const [address, setAddress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!address.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await addTarget(label.trim(), address.trim());
      setLabel("");
      setAddress("");
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card card-enter p-4" style={{ animationDelay: "160ms" }}>
      <h2 className="text-[0.72rem] font-semibold uppercase tracking-[0.16em] text-ink-3">
        Targets
      </h2>
      <ul className="mt-3 space-y-2">
        {targets.map((t, i) => (
          <li
            key={t.id}
            className="group flex items-center gap-2.5 rounded-lg border border-line bg-surface px-2.5 py-2"
          >
            <span className="size-2 shrink-0 rounded-full" style={{ background: colorForIndex(i) }} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[0.8rem] font-medium">{t.label}</div>
              <div className="truncate font-mono text-[0.66rem] text-ink-3">
                {t.address}
                {t.kind === "gateway" && " · your router"}
              </div>
            </div>
            {targets.length > 1 && (
              <button
                onClick={() => removeTarget(t.id)}
                className="rounded p-1 text-ink-3 opacity-0 transition-opacity hover:text-bad group-hover:opacity-100"
                title={`Remove ${t.label}`}
              >
                <svg width="10" height="10" viewBox="0 0 10 10" stroke="currentColor" strokeWidth="1.6">
                  <path d="M1 1l8 8M9 1l-8 8" />
                </svg>
              </button>
            )}
          </li>
        ))}
      </ul>

      <form onSubmit={onAdd} className="mt-3 space-y-2 border-t border-line pt-3">
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Label (optional)"
          className="w-full"
        />
        <div className="flex gap-2">
          <input
            type="text"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="Host or IP, e.g. 9.9.9.9"
            className="min-w-0 flex-1"
          />
          <button
            type="submit"
            disabled={!address.trim() || busy}
            className="rounded-lg border border-line-2 px-3 text-xs text-ink-2 transition-colors hover:border-accent hover:text-ink disabled:opacity-40"
          >
            {busy ? "…" : "Add"}
          </button>
        </div>
        {error && <p className="text-[0.7rem] text-bad">{error}</p>}
      </form>
    </div>
  );
}
