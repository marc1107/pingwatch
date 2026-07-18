import { useMemo } from "react";
import { detectSpikes } from "../lib/stats";
import type { Sample, SpikeEvent, Target } from "../lib/types";
import { fmtClock, fmtDuration, fmtMs } from "../lib/format";

interface Props {
  targets: Target[];
  colors: string[];
  samplesByTarget: Record<string, Sample[]>;
  thresholdMs: number;
  windowMinUtcMs: number;
}

interface Row extends SpikeEvent {
  targetLabel: string;
  color: string;
}

export default function SpikeLog({ targets, colors, samplesByTarget, thresholdMs, windowMinUtcMs }: Props) {
  const rows = useMemo<Row[]>(() => {
    const all: Row[] = [];
    targets.forEach((target, i) => {
      const samples = (samplesByTarget[target.id] ?? []).filter((s) => s.tUtcMs >= windowMinUtcMs);
      for (const event of detectSpikes(samples, thresholdMs)) {
        all.push({ ...event, targetLabel: target.label, color: colors[i] });
      }
    });
    return all.sort((a, b) => b.startUtcMs - a.startUtcMs).slice(0, 40);
  }, [targets, colors, samplesByTarget, thresholdMs, windowMinUtcMs]);

  return (
    <div className="card card-enter flex min-h-0 flex-col p-4" style={{ animationDelay: "230ms" }}>
      <div className="flex items-baseline justify-between">
        <h2 className="text-[0.72rem] font-semibold uppercase tracking-[0.16em] text-ink-3">
          Spike log
        </h2>
        <span className="font-mono text-[0.68rem] text-ink-3">
          &gt;{thresholdMs} ms or loss · in window
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="mt-4 text-center text-xs text-ink-3">
          No spikes in the current window — smooth sailing.
        </p>
      ) : (
        <ul className="mt-2 min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
          {rows.map((row) => (
            <li
              key={`${row.targetLabel}-${row.startUtcMs}`}
              className="flex items-center gap-2.5 rounded-md px-1.5 py-1 text-[0.72rem] hover:bg-surface-3"
            >
              <span className="font-mono text-ink-3">{fmtClock(row.startUtcMs)}</span>
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="size-1.5 shrink-0 rounded-full" style={{ background: row.color }} />
                <span className="truncate text-ink-2">{row.targetLabel}</span>
              </span>
              <span className="ml-auto flex shrink-0 items-center gap-2 font-mono">
                {row.hasLoss && (
                  <span className="rounded bg-bad/15 px-1.5 py-px text-[0.62rem] font-medium text-bad">
                    LOSS
                  </span>
                )}
                {row.peakRttMs !== null && <span className="text-ink">{fmtMs(row.peakRttMs)} ms</span>}
                <span className="text-ink-3">{fmtDuration(row.endUtcMs - row.startUtcMs)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
