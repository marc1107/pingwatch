import { useMemo, useState } from "react";
import { useStore } from "../state/store";
import { alignSessions } from "../lib/align";
import { computeStats } from "../lib/stats";
import type { Sample, Session, TargetStats } from "../lib/types";
import { fmtDateTime, fmtDuration, fmtMs, fmtPct } from "../lib/format";
import LiveChart, { type ChartSeries } from "./LiveChart";

const COLOR_A = "#1e96c8";
const COLOR_B = "#c4741f";

function sessionTitle(s: Session): string {
  return `${s.device.connectionLabel} · ${s.device.hostname}`;
}

function SessionBadge({ session, color }: { session: Session; color: string }) {
  const duration =
    (session.endedUtcMs ?? session.startedUtcMs) - session.startedUtcMs;
  return (
    <div className="card flex-1 p-4">
      <div className="flex items-center gap-2">
        <span className="size-2.5 rounded-sm" style={{ background: color }} />
        <span className="truncate font-semibold">{session.device.connectionLabel}</span>
        <span className="rounded-full border border-line-2 px-2 py-px text-[0.62rem] uppercase tracking-wider text-ink-3">
          {session.device.os}
        </span>
      </div>
      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[0.72rem]">
        <div className="flex justify-between gap-2">
          <dt className="text-ink-3">Host</dt>
          <dd className="truncate font-mono">{session.device.hostname}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-ink-3">Started</dt>
          <dd className="truncate font-mono" title={`Recorded in ${session.timezone}`}>
            {fmtDateTime(session.startedUtcMs)}
          </dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-ink-3">Duration</dt>
          <dd className="font-mono">{fmtDuration(duration)}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-ink-3">Rate</dt>
          <dd className="font-mono">
            {session.intervalMs >= 1000 ? `${session.intervalMs / 1000}s` : `${1000 / session.intervalMs}/s`}
          </dd>
        </div>
      </dl>
    </div>
  );
}

interface AddressComparison {
  address: string;
  label: string;
  statsA: TargetStats;
  statsB: TargetStats;
  isGateway: boolean;
}

function samplesForAddress(session: Session, address: string): Sample[] {
  const ids = new Set(session.targets.filter((t) => t.address === address).map((t) => t.id));
  return session.samples.filter((s) => ids.has(s.targetId));
}

function DeltaCell({ a, b, unit, lowerIsBetter = true }: { a: number | null; b: number | null; unit: string; lowerIsBetter?: boolean }) {
  const fmt = unit === "%" ? (v: number) => fmtPct(v) : (v: number) => fmtMs(v);
  if (a === null || b === null) {
    return (
      <td className="px-3 py-2 text-right font-mono text-ink-3">
        {a === null ? "–" : fmt(a)} / {b === null ? "–" : fmt(b)}
      </td>
    );
  }
  const delta = b - a;
  const significant = Math.abs(delta) > Math.max(0.15 * Math.max(a, b), unit === "%" ? 0.2 : 1);
  const bWins = lowerIsBetter ? delta < 0 : delta > 0;
  const deltaColor = !significant ? "var(--color-ink-3)" : bWins ? "var(--color-good)" : "var(--color-bad)";
  return (
    <td className="whitespace-nowrap px-3 py-2 text-right font-mono">
      <span style={{ color: COLOR_A }}>{fmt(a)}</span>
      <span className="text-ink-3"> / </span>
      <span style={{ color: COLOR_B }}>{fmt(b)}</span>
      <span className="ml-1.5 text-[0.68rem]" style={{ color: deltaColor }}>
        {delta > 0 ? "+" : ""}
        {fmt(delta)}
        {unit}
      </span>
    </td>
  );
}

function verdict(comparisons: AddressComparison[], a: Session, b: Session): string[] {
  const lines: string[] = [];
  const nameA = a.device.connectionLabel;
  const nameB = b.device.connectionLabel;

  const worse = (sa: TargetStats, sb: TargetStats): "A" | "B" | null => {
    const score = (s: TargetStats) => (s.p95 ?? 0) + (s.jitterMs ?? 0) * 2 + s.lossPct * 50;
    const scoreA = score(sa);
    const scoreB = score(sb);
    if (Math.abs(scoreA - scoreB) < Math.max(5, 0.2 * Math.max(scoreA, scoreB))) return null;
    return scoreA > scoreB ? "A" : "B";
  };

  const gw = comparisons.find((c) => c.isGateway);
  const inet = comparisons.filter((c) => !c.isGateway);

  if (gw) {
    const w = worse(gw.statsA, gw.statsB);
    lines.push(
      w === null
        ? `Both machines reach the router equally well — the local links look comparable.`
        : `${w === "A" ? nameA : nameB} has the worse path to the router (higher p95/jitter/loss on the gateway) — its local link (often the wireless one) is the likely culprit.`,
    );
  }
  if (inet.length > 0) {
    const wins = inet.map((c) => worse(c.statsA, c.statsB));
    const aWorse = wins.filter((w) => w === "A").length;
    const bWorse = wins.filter((w) => w === "B").length;
    lines.push(
      aWorse === 0 && bWorse === 0
        ? `Internet targets perform similarly from both machines.`
        : `${aWorse > bWorse ? nameA : nameB} is consistently worse on internet targets (${Math.max(aWorse, bWorse)}/${inet.length}).`,
    );
    if (gw) {
      const gwWorse = worse(gw.statsA, gw.statsB);
      const inetWorse = aWorse > bWorse ? "A" : bWorse > aWorse ? "B" : null;
      if (inetWorse && gwWorse === null) {
        lines.push(
          `Since the router hop is clean on both, the difference on internet targets points beyond the router (provider or routing).`,
        );
      } else if (inetWorse && gwWorse === inetWorse) {
        lines.push(
          `The same machine also struggles on the router hop, so the problem is local (that machine's link to the router), not the provider.`,
        );
      }
    }
  }
  return lines;
}

export default function CompareView() {
  const importedSessions = useStore((s) => s.importedSessions);
  const startedUtcMs = useStore((s) => s.startedUtcMs);
  const samplesCount = useStore((s) => Object.keys(s.samplesByTarget).length);
  const { importFile, removeImported, buildSession } = useStore.getState();

  const current = useMemo(
    () => (startedUtcMs !== null && samplesCount > 0 ? buildSession() : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [startedUtcMs, samplesCount, importedSessions],
  );

  const pool: Session[] = useMemo(() => {
    const list = [...importedSessions];
    if (current) {
      list.unshift({
        ...current,
        device: { ...current.device, connectionLabel: `${current.device.connectionLabel || "current"} (this device)` },
      });
    }
    return list;
  }, [importedSessions, current]);

  const [idA, setIdA] = useState<string | null>(null);
  const [idB, setIdB] = useState<string | null>(null);
  const a = pool.find((s) => s.id === idA) ?? pool[0] ?? null;
  const b = pool.find((s) => s.id === idB && s.id !== a?.id) ?? pool.find((s) => s.id !== a?.id) ?? null;

  const aligned = useMemo(() => (a && b ? alignSessions(a, b, 1000) : null), [a, b]);

  const comparisons: AddressComparison[] = useMemo(() => {
    if (!a || !b) return [];
    const addressesA = new Map(a.targets.map((t) => [t.address, t]));
    return b.targets
      .filter((t) => addressesA.has(t.address))
      .map((t) => ({
        address: t.address,
        label: addressesA.get(t.address)?.label ?? t.label,
        isGateway: t.kind === "gateway" || addressesA.get(t.address)?.kind === "gateway",
        statsA: computeStats(samplesForAddress(a, t.address), 100),
        statsB: computeStats(samplesForAddress(b, t.address), 100),
      }));
  }, [a, b]);

  const chartData = useMemo(() => {
    if (!a || !b || !aligned) return null;
    const toSamples = (points: { tUtcMs: number; avgRttMs: number | null }[], id: string): Sample[] =>
      points.map((p, i) => ({ targetId: id, seq: i, tUtcMs: p.tUtcMs, rttMs: p.avgRttMs }));
    // Overlay per common address would multiply charts; the overview chart
    // averages each session across its common targets per bucket instead.
    const common = new Set(comparisons.map((c) => c.address));
    const filterCommon = (s: Session): Session => ({
      ...s,
      samples: s.samples.filter((smp) =>
        s.targets.some((t) => t.id === smp.targetId && common.has(t.address)),
      ),
    });
    const overview = alignSessions(filterCommon(a), filterCommon(b), 1000);
    const series: ChartSeries[] = [
      { id: "a", label: sessionTitle(a), color: COLOR_A, samples: toSamples(overview.a, "a") },
      { id: "b", label: sessionTitle(b), color: COLOR_B, samples: toSamples(overview.b, "b") },
    ];
    const xs = [...overview.a, ...overview.b].map((p) => p.tUtcMs);
    if (xs.length === 0) return null;
    return {
      series,
      mode: overview.mode,
      window: [Math.min(...xs), Math.max(...xs) + 1000] as [number, number],
    };
  }, [a, b, aligned, comparisons]);

  if (pool.length === 0) {
    return (
      <div className="card card-enter mx-auto mt-16 max-w-md p-8 text-center">
        <h2 className="font-display text-lg font-semibold">Compare sessions</h2>
        <p className="mt-2 text-sm leading-relaxed text-ink-2">
          Export a session from this machine, run PingWatch on another computer on the same
          network, export there too — then import both files here to see the two connections
          side by side.
        </p>
        <button
          onClick={() => importFile()}
          className="mt-5 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-accent-bright"
        >
          Import session file…
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="card card-enter flex flex-wrap items-center gap-3 px-4 py-3">
        <span className="text-[0.68rem] uppercase tracking-[0.12em] text-ink-3">Sessions</span>
        <select value={a?.id ?? ""} onChange={(e) => setIdA(e.target.value)}>
          {pool.map((s) => (
            <option key={s.id} value={s.id}>
              {sessionTitle(s)}
            </option>
          ))}
        </select>
        <span className="text-ink-3">vs</span>
        <select value={b?.id ?? ""} onChange={(e) => setIdB(e.target.value)} disabled={pool.length < 2}>
          {pool
            .filter((s) => s.id !== a?.id)
            .map((s) => (
              <option key={s.id} value={s.id}>
                {sessionTitle(s)}
              </option>
            ))}
        </select>
        <div className="ml-auto flex gap-2">
          <button
            onClick={() => importFile()}
            className="rounded-lg border border-line-2 px-3 py-1.5 text-xs text-ink-2 transition-colors hover:border-accent hover:text-ink"
          >
            Import…
          </button>
          {importedSessions.map((s) => (
            <button
              key={s.id}
              onClick={() => removeImported(s.id)}
              className="rounded-lg border border-line-2 px-3 py-1.5 text-xs text-ink-3 transition-colors hover:border-bad hover:text-bad"
              title={`Remove ${sessionTitle(s)}`}
            >
              ✕ {s.device.connectionLabel}
            </button>
          ))}
        </div>
      </div>

      {!b && (
        <p className="card card-enter px-4 py-6 text-center text-sm text-ink-2">
          Import a second session (or record one here) to compare.
        </p>
      )}

      {a && b && aligned && (
        <>
          <div className="flex flex-col gap-4 md:flex-row">
            <SessionBadge session={a} color={COLOR_A} />
            <SessionBadge session={b} color={COLOR_B} />
          </div>

          {chartData && (
            <div className="card card-enter p-4" style={{ animationDelay: "80ms" }}>
              <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[0.72rem]">
                {chartData.series.map((s) => (
                  <span key={s.id} className="flex items-center gap-1.5 text-ink-2">
                    <span className="h-[3px] w-4 rounded-full" style={{ background: s.color }} />
                    {s.label}
                  </span>
                ))}
                <span className="ml-auto font-mono text-[0.68rem] text-ink-3">
                  {chartData.mode === "absolute"
                    ? "aligned on real (UTC) time — 1 s buckets"
                    : "no time overlap — aligned on elapsed time since each start"}
                </span>
              </div>
              <LiveChart
                series={chartData.series}
                windowUtcMs={chartData.window}
                thresholdMs={100}
                height={300}
                timeMode={chartData.mode === "absolute" ? "clock" : "elapsed"}
              />
            </div>
          )}

          <div className="card card-enter overflow-x-auto" style={{ animationDelay: "140ms" }}>
            <table className="w-full text-[0.78rem]">
              <thead>
                <tr className="border-b border-line text-left text-[0.65rem] uppercase tracking-[0.12em] text-ink-3">
                  <th className="px-3 py-2.5 font-medium">Common target</th>
                  <th className="px-3 py-2.5 text-right font-medium">
                    avg <span style={{ color: COLOR_A }}>A</span>/<span style={{ color: COLOR_B }}>B</span> ms
                  </th>
                  <th className="px-3 py-2.5 text-right font-medium">p95 ms</th>
                  <th className="px-3 py-2.5 text-right font-medium">jitter ms</th>
                  <th className="px-3 py-2.5 text-right font-medium">loss %</th>
                </tr>
              </thead>
              <tbody>
                {comparisons.map((c) => (
                  <tr key={c.address} className="border-b border-line/60 last:border-0">
                    <td className="px-3 py-2">
                      <div className="font-medium">{c.label}</div>
                      <div className="font-mono text-[0.66rem] text-ink-3">
                        {c.address}
                        {c.isGateway && " · router"}
                      </div>
                    </td>
                    <DeltaCell a={c.statsA.avg} b={c.statsB.avg} unit="" />
                    <DeltaCell a={c.statsA.p95} b={c.statsB.p95} unit="" />
                    <DeltaCell a={c.statsA.jitterMs} b={c.statsB.jitterMs} unit="" />
                    <DeltaCell a={c.statsA.lossPct} b={c.statsB.lossPct} unit="%" />
                  </tr>
                ))}
                {comparisons.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-3 py-6 text-center text-ink-3">
                      These sessions share no common target addresses, so there is nothing to
                      compare directly.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {comparisons.length > 0 && (
            <div className="card card-enter p-4" style={{ animationDelay: "200ms" }}>
              <h2 className="text-[0.72rem] font-semibold uppercase tracking-[0.16em] text-ink-3">
                Verdict
              </h2>
              <ul className="mt-2 space-y-1.5 text-[0.82rem] leading-relaxed text-ink-2">
                {verdict(comparisons, a, b).map((line) => (
                  <li key={line} className="flex gap-2">
                    <span className="mt-[7px] size-1 shrink-0 rounded-full bg-accent-bright" />
                    {line}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}
