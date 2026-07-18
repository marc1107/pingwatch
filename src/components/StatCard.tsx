import type { Health, Target, TargetStats } from "../lib/types";
import { fmtMs, fmtPct } from "../lib/format";

const HEALTH_META: Record<Health, { label: string; color: string }> = {
  good: { label: "Good", color: "var(--color-good)" },
  warn: { label: "Fair", color: "var(--color-warn)" },
  bad: { label: "Poor", color: "var(--color-bad)" },
};

interface Props {
  target: Target;
  color: string;
  stats: TargetStats;
  health: Health;
  index: number;
}

function Cell({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div>
      <div className="text-[0.62rem] uppercase tracking-[0.14em] text-ink-3">{label}</div>
      <div className="font-mono text-sm text-ink">
        {value}
        {unit && <span className="ml-0.5 text-[0.65rem] text-ink-3">{unit}</span>}
      </div>
    </div>
  );
}

export default function StatCard({ target, color, stats, health, index }: Props) {
  const meta = HEALTH_META[health];
  return (
    <div
      className="card card-enter relative overflow-hidden p-4"
      style={{ animationDelay: `${80 + index * 70}ms` }}
    >
      <div className="absolute inset-y-0 left-0 w-[3px]" style={{ background: color }} />
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="size-2 shrink-0 rounded-full" style={{ background: color }} />
            <span className="truncate font-semibold text-[0.9rem]">{target.label}</span>
          </div>
          <div className="mt-0.5 font-mono text-[0.68rem] text-ink-3">{target.address}</div>
        </div>
        <span
          className="flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[0.68rem] font-medium"
          style={{ color: meta.color, borderColor: "var(--color-line-2)" }}
        >
          <span className="size-1.5 rounded-full" style={{ background: meta.color }} />
          {meta.label}
        </span>
      </div>

      <div className="mt-3 flex items-baseline gap-1.5">
        <span className="font-mono text-3xl font-medium tracking-tight">{fmtMs(stats.current)}</span>
        <span className="text-xs text-ink-3">ms now</span>
      </div>

      <div className="mt-3 grid grid-cols-4 gap-x-3 gap-y-2 border-t border-line pt-3">
        <Cell label="avg" value={fmtMs(stats.avg)} />
        <Cell label="min" value={fmtMs(stats.min)} />
        <Cell label="max" value={fmtMs(stats.max)} />
        <Cell label="p95" value={fmtMs(stats.p95)} />
        <Cell label="jitter" value={fmtMs(stats.jitterMs)} />
        <Cell label="loss" value={fmtPct(stats.lossPct)} unit="%" />
        <Cell label="spikes" value={String(stats.spikeCount)} />
        <Cell label="pings" value={String(stats.count)} />
      </div>
    </div>
  );
}
