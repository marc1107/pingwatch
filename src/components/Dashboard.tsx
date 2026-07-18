import { useMemo } from "react";
import { useStore } from "../state/store";
import { computeStats, healthOf } from "../lib/stats";
import { colorForIndex, fmtMs } from "../lib/format";
import LiveChart, { type ChartSeries } from "./LiveChart";
import StatCard from "./StatCard";
import ControlBar from "./ControlBar";
import TargetManager from "./TargetManager";
import SpikeLog from "./SpikeLog";

function ReadingHint() {
  return (
    <details className="card card-enter group p-4" style={{ animationDelay: "300ms" }}>
      <summary className="cursor-pointer select-none text-[0.72rem] font-semibold uppercase tracking-[0.16em] text-ink-3 transition-colors hover:text-ink-2">
        How to read the results
      </summary>
      <ul className="mt-3 space-y-2 text-[0.78rem] leading-relaxed text-ink-2">
        <li>
          <strong className="text-ink">Router spikes too</strong> — if the gateway trace spikes
          together with the internet targets, the problem is inside your local network (router
          load, Wi-Fi interference, cabling).
        </li>
        <li>
          <strong className="text-ink">Router clean, internet spiky</strong> — a flat gateway
          trace with spiky internet targets points upstream: your provider or the route beyond
          the router.
        </li>
        <li>
          <strong className="text-ink">Compare machines</strong> — export a session here, run
          PingWatch on another machine on the same router (e.g. wired vs. wireless), and open
          both in the Compare tab. If only the wireless machine spikes, it&apos;s the wireless
          link.
        </li>
        <li>
          <strong className="text-ink">What matters for gaming</strong> — steady average, low
          jitter (&lt;15 ms) and zero loss beat a low average with spikes. Single spikes over
          100 ms are what you feel as stutter.
        </li>
      </ul>
    </details>
  );
}

export default function Dashboard() {
  const targets = useStore((s) => s.targets);
  const samplesByTarget = useStore((s) => s.samplesByTarget);
  const windowMin = useStore((s) => s.windowMin);
  const spikeThresholdMs = useStore((s) => s.spikeThresholdMs);
  const running = useStore((s) => s.running);
  const startedUtcMs = useStore((s) => s.startedUtcMs);

  const nowMs = useMemo(() => {
    const last = Object.values(samplesByTarget)
      .flat()
      .reduce((max, s) => Math.max(max, s.tUtcMs), 0);
    return running || last === 0 ? Date.now() : last;
  }, [samplesByTarget, running]);

  const windowUtcMs: [number, number] = [nowMs - windowMin * 60_000, nowMs];

  const series: ChartSeries[] = targets.map((t, i) => ({
    id: t.id,
    label: t.label,
    color: colorForIndex(i),
    samples: samplesByTarget[t.id] ?? [],
  }));

  const statsList = targets.map((t) => {
    const windowSamples = (samplesByTarget[t.id] ?? []).filter((s) => s.tUtcMs >= windowUtcMs[0]);
    return computeStats(windowSamples, spikeThresholdMs);
  });

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_290px]">
      <div className="min-w-0 space-y-4">
        <ControlBar />

        <div className="card card-enter p-4" style={{ animationDelay: "60ms" }}>
          <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1">
            {series.map((s, i) => (
              <span key={s.id} className="flex items-center gap-1.5 text-[0.72rem] text-ink-2">
                <span className="h-[3px] w-4 rounded-full" style={{ background: s.color }} />
                {s.label}
                <span className="font-mono text-ink-3">{fmtMs(statsList[i]?.current)} ms</span>
              </span>
            ))}
            <span className="ml-auto font-mono text-[0.68rem] text-ink-3">
              {startedUtcMs === null
                ? "idle — press Start"
                : running
                  ? "live"
                  : "stopped"}
            </span>
          </div>
          <LiveChart series={series} windowUtcMs={windowUtcMs} thresholdMs={spikeThresholdMs} />
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 2xl:grid-cols-3">
          {targets.map((t, i) => (
            <StatCard
              key={t.id}
              target={t}
              color={colorForIndex(i)}
              stats={statsList[i]}
              health={healthOf(statsList[i])}
              index={i}
            />
          ))}
        </div>
      </div>

      <div className="flex min-w-0 flex-col gap-4">
        <TargetManager />
        <SpikeLog
          targets={targets}
          colors={targets.map((_t, i) => colorForIndex(i))}
          samplesByTarget={samplesByTarget}
          thresholdMs={spikeThresholdMs}
          windowMinUtcMs={windowUtcMs[0]}
        />
        <ReadingHint />
      </div>
    </div>
  );
}
