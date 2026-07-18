import { bucketize } from "./align";
import { computeStats, detectSpikes } from "./stats";
import type { AlignedPoint, Sample, Session, SpikeEvent, Target } from "./types";

export type FindingSeverity = "info" | "notable" | "warning" | "critical";

export interface Finding {
  id: string; // stable slug, e.g. "spike-rate:A:1.1.1.1"
  severity: FindingSeverity;
  scope: { session: "A" | "B" | "both"; targetAddress?: string };
  title: string; // short, includes the headline number, e.g. "Session A: 2.3 spikes/min on 1.1.1.1"
  metrics: Record<string, number | string>; // the verified numbers backing the title
  detail: string; // 1-2 factual sentences, deterministic, no speculation
}

export interface FindingsInput {
  a: Session;
  b: Session;
  spikeThresholdMs?: number; // default 100
}

const DEFAULT_SPIKE_THRESHOLD_MS = 100;
const MAX_FINDINGS = 24;

const SEVERITY_RANK: Record<FindingSeverity, number> = {
  critical: 0,
  warning: 1,
  notable: 2,
  info: 3,
};

type SessionLetter = "A" | "B";

interface SessionCtx {
  letter: SessionLetter;
  session: Session;
  durationMs: number;
  durationMin: number;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Session end time: explicit end, or the last sample's timestamp, or the start if there are no samples. */
function sessionEndMs(session: Session): number {
  return (
    session.endedUtcMs ??
    session.samples.reduce((max, sample) => Math.max(max, sample.tUtcMs), session.startedUtcMs)
  );
}

function makeCtx(letter: SessionLetter, session: Session): SessionCtx {
  const durationMs = Math.max(0, sessionEndMs(session) - session.startedUtcMs);
  return { letter, session, durationMs, durationMin: durationMs / 60_000 };
}

function samplesForTarget(session: Session, targetId: string): Sample[] {
  return session.samples.filter((s) => s.targetId === targetId);
}

function targetByAddress(session: Session, address: string): Target | undefined {
  return session.targets.find((t) => t.address === address);
}

/** Addresses present in both sessions' target lists, in `a`'s target order. */
function commonTargetAddresses(a: Session, b: Session): string[] {
  const bAddresses = new Set(b.targets.map((t) => t.address));
  const seen = new Set<string>();
  const result: string[] = [];
  for (const target of a.targets) {
    if (bAddresses.has(target.address) && !seen.has(target.address)) {
      seen.add(target.address);
      result.push(target.address);
    }
  }
  return result;
}

function round(value: number, decimals = 1): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function median(sortedAscending: number[]): number {
  const n = sortedAscending.length;
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (sortedAscending[mid - 1] + sortedAscending[mid]) / 2 : sortedAscending[mid];
}

function formatOffset(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const mm = Math.floor(totalSec / 60);
  const ss = totalSec % 60;
  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// 1. spikeRate
// ---------------------------------------------------------------------------

function spikeRateFindings(
  ctx: SessionCtx,
  target: Target,
  samples: Sample[],
  thresholdMs: number,
): Finding[] {
  if (ctx.durationMin <= 0) return [];
  const spikes = detectSpikes(samples, thresholdMs);
  const rate = spikes.length / ctx.durationMin;
  if (rate <= 0) return [];

  let severity: FindingSeverity;
  if (rate >= 1) severity = "critical";
  else if (rate >= 0.3) severity = "warning";
  else if (rate >= 0.05) severity = "notable";
  else severity = "info";

  return [
    {
      id: `spike-rate:${ctx.letter}:${target.address}`,
      severity,
      scope: { session: ctx.letter, targetAddress: target.address },
      title: `Session ${ctx.letter}: ${round(rate, 1)} spikes/min on ${target.address}`,
      metrics: { ratePerMin: round(rate, 2), spikeCount: spikes.length, durationMin: round(ctx.durationMin, 2) },
      detail: `Session ${ctx.letter} (${ctx.session.device.connectionLabel}) recorded ${spikes.length} spike event(s) on ${target.address} over ${round(ctx.durationMin, 1)} min, a rate of ${round(rate, 2)} spikes/min at the ${thresholdMs} ms threshold.`,
    },
  ];
}

// ---------------------------------------------------------------------------
// 2. spikeSeverity
// ---------------------------------------------------------------------------

function spikeSeverityFindings(
  ctx: SessionCtx,
  target: Target,
  samples: Sample[],
  thresholdMs: number,
): Finding[] {
  const spikes = detectSpikes(samples, thresholdMs);
  if (spikes.length < 3) return [];

  const peaks = spikes
    .map((s) => s.peakRttMs)
    .filter((p): p is number => p !== null)
    .sort((a, b) => a - b);
  const peakMedian = peaks.length ? median(peaks) : null;
  const peakMax = peaks.length ? peaks[peaks.length - 1] : null;
  const longestSec = Math.max(...spikes.map((s) => (s.endUtcMs - s.startUtcMs) / 1000));

  let severity: FindingSeverity;
  if ((peakMax !== null && peakMax >= 400) || longestSec >= 5) severity = "warning";
  else if (peakMax !== null && peakMax >= 200) severity = "notable";
  else severity = "info";

  const peakText = peakMax !== null ? `peaking at ${round(peakMax, 0)} ms` : "pure packet loss (no peak RTT)";
  const metrics: Record<string, number | string> = {
    spikeCount: spikes.length,
    longestEventSec: round(longestSec, 1),
  };
  if (peakMedian !== null) metrics.medianPeakMs = round(peakMedian, 0);
  if (peakMax !== null) metrics.maxPeakMs = round(peakMax, 0);

  return [
    {
      id: `spike-severity:${ctx.letter}:${target.address}`,
      severity,
      scope: { session: ctx.letter, targetAddress: target.address },
      title: `Session ${ctx.letter}: ${spikes.length} spikes ${peakText} on ${target.address}`,
      metrics,
      detail: `Session ${ctx.letter} (${ctx.session.device.connectionLabel}) saw ${spikes.length} spikes on ${target.address}; the longest lasted ${round(longestSec, 1)} s${peakMedian !== null ? ` and the median peak was ${round(peakMedian, 0)} ms` : ""}.`,
    },
  ];
}

// ---------------------------------------------------------------------------
// 3. packetLoss
// ---------------------------------------------------------------------------

function packetLossFindings(
  ctx: SessionCtx,
  target: Target,
  samples: Sample[],
  thresholdMs: number,
): Finding[] {
  const stats = computeStats(samples, thresholdMs);
  if (stats.lossPct <= 0) return [];

  let severity: FindingSeverity;
  if (stats.lossPct >= 2) severity = "critical";
  else if (stats.lossPct >= 1) severity = "warning";
  else if (stats.lossPct >= 0.3) severity = "notable";
  else severity = "info";

  return [
    {
      id: `packet-loss:${ctx.letter}:${target.address}`,
      severity,
      scope: { session: ctx.letter, targetAddress: target.address },
      title: `Session ${ctx.letter}: ${round(stats.lossPct, 2)}% loss on ${target.address}`,
      metrics: { lossPct: round(stats.lossPct, 2), lossCount: stats.lossCount, count: stats.count },
      detail: `Session ${ctx.letter} (${ctx.session.device.connectionLabel}) lost ${stats.lossCount} of ${stats.count} pings to ${target.address} (${round(stats.lossPct, 2)}%).`,
    },
  ];
}

// ---------------------------------------------------------------------------
// 4. timeAboveThresholds
// ---------------------------------------------------------------------------

function timeAboveThresholdsFindings(ctx: SessionCtx): Finding[] {
  const internetTargets = ctx.session.targets.filter((t) => t.kind === "internet");
  let worst: { target: Target; share50: number; share100: number; share200: number } | null = null;

  for (const target of internetTargets) {
    const buckets = bucketize(samplesForTarget(ctx.session, target.id), 1000);
    if (buckets.length === 0) continue;
    let above50 = 0;
    let above100 = 0;
    let above200 = 0;
    for (const bucket of buckets) {
      if (bucket.avgRttMs === null) continue;
      if (bucket.avgRttMs > 50) above50 += 1;
      if (bucket.avgRttMs > 100) above100 += 1;
      if (bucket.avgRttMs > 200) above200 += 1;
    }
    const share50 = (above50 / buckets.length) * 100;
    const share100 = (above100 / buckets.length) * 100;
    const share200 = (above200 / buckets.length) * 100;
    if (!worst || share100 > worst.share100) worst = { target, share50, share100, share200 };
  }

  if (!worst) return [];
  const { target, share50, share100, share200 } = worst;

  let severity: FindingSeverity;
  if (share100 >= 10) severity = "critical";
  else if (share100 >= 3) severity = "warning";
  else if (share100 >= 1) severity = "notable";
  else if (share100 > 0) severity = "info";
  else return [];

  return [
    {
      id: `time-above-threshold:${ctx.letter}:${target.address}`,
      severity,
      scope: { session: ctx.letter, targetAddress: target.address },
      title: `Session ${ctx.letter}: ${round(share100, 1)}% of time >100ms on ${target.address}`,
      metrics: {
        share50Pct: round(share50, 2),
        share100Pct: round(share100, 2),
        share200Pct: round(share200, 2),
      },
      detail: `Session ${ctx.letter} (${ctx.session.device.connectionLabel}) spent ${round(share50, 1)}% of its 1s buckets above 50ms, ${round(share100, 1)}% above 100ms, and ${round(share200, 1)}% above 200ms on its worst internet target, ${target.address}.`,
    },
  ];
}

// ---------------------------------------------------------------------------
// 5. worstStretch
// ---------------------------------------------------------------------------

function longestBadRun(
  buckets: AlignedPoint[],
  thresholdMs: number,
): { lengthSec: number; startUtcMs: number } {
  let bestLen = 0;
  let bestStart = -1;
  let curLen = 0;
  let curStart = -1;

  for (const bucket of buckets) {
    const bad = bucket.avgRttMs === null || bucket.avgRttMs > thresholdMs;
    if (bad) {
      // Only treat this bucket as extending the active run if it immediately
      // follows the previous bucket *of that same run* in time; otherwise it
      // starts a new run (covers both a time gap and a preceding good bucket).
      const continuesRun = curLen > 0 && bucket.tUtcMs === curStart + curLen * 1000;
      if (continuesRun) {
        curLen += 1;
      } else {
        curStart = bucket.tUtcMs;
        curLen = 1;
      }
      if (curLen > bestLen) {
        bestLen = curLen;
        bestStart = curStart;
      }
    } else {
      curLen = 0;
      curStart = -1;
    }
  }

  return { lengthSec: bestLen, startUtcMs: bestStart };
}

function worstStretchFindings(
  ctx: SessionCtx,
  target: Target,
  samples: Sample[],
  thresholdMs: number,
): Finding[] {
  const buckets = bucketize(samples, 1000);
  const run = longestBadRun(buckets, thresholdMs);
  if (run.lengthSec < 3) return [];

  let severity: FindingSeverity;
  if (run.lengthSec >= 15) severity = "critical";
  else if (run.lengthSec >= 8) severity = "warning";
  else severity = "notable";

  const offsetMs = run.startUtcMs - ctx.session.startedUtcMs;
  const offsetLabel = formatOffset(offsetMs);

  return [
    {
      id: `worst-stretch:${ctx.letter}:${target.address}`,
      severity,
      scope: { session: ctx.letter, targetAddress: target.address },
      title: `Session ${ctx.letter}: ${run.lengthSec}s bad stretch on ${target.address} at ${offsetLabel}`,
      metrics: { durationSec: run.lengthSec, startOffsetSec: Math.round(offsetMs / 1000) },
      detail: `Session ${ctx.letter} (${ctx.session.device.connectionLabel}) had a continuous ${run.lengthSec}s stretch of degraded or lost pings to ${target.address}, starting at ${offsetLabel} into the session.`,
    },
  ];
}

// ---------------------------------------------------------------------------
// 6. periodicity
// ---------------------------------------------------------------------------

function periodicityFindings(
  ctx: SessionCtx,
  target: Target,
  samples: Sample[],
  thresholdMs: number,
): Finding[] {
  const spikes = detectSpikes(samples, thresholdMs);
  if (spikes.length < 5) return [];
  if (ctx.durationMs <= 0) return [];

  const n = Math.max(1, Math.ceil(ctx.durationMs / 1000));
  const indicator = new Float64Array(n);
  for (const spike of spikes) {
    const startSec = Math.max(0, Math.floor((spike.startUtcMs - ctx.session.startedUtcMs) / 1000));
    const endSec = Math.min(n - 1, Math.floor((spike.endUtcMs - ctx.session.startedUtcMs) / 1000));
    for (let t = startSec; t <= endSec; t += 1) indicator[t] = 1;
  }

  const mean = indicator.reduce((a, b) => a + b, 0) / n;
  const y = Array.from(indicator, (v) => v - mean);
  const denom = y.reduce((a, v) => a + v * v, 0);
  if (denom <= 0) return [];

  const maxLag = Math.min(300, n - 1);
  let bestLag = -1;
  let bestCorr = -Infinity;
  for (let lag = 10; lag <= maxLag; lag += 1) {
    let sum = 0;
    for (let t = 0; t < n - lag; t += 1) sum += y[t] * y[t + lag];
    const corr = sum / denom;
    if (corr > bestCorr) {
      bestCorr = corr;
      bestLag = lag;
    }
  }
  if (bestLag < 0) return [];

  const durationSec = ctx.durationMs / 1000;
  const repetitions = Math.floor(durationSec / bestLag);
  if (bestCorr < 0.35 || repetitions < 3) return [];

  return [
    {
      id: `periodicity:${ctx.letter}:${target.address}`,
      severity: "notable",
      scope: { session: ctx.letter, targetAddress: target.address },
      title: `Session ${ctx.letter}: spikes recur roughly every ${bestLag}s on ${target.address}`,
      metrics: { lagSec: bestLag, correlation: round(bestCorr, 2), repetitions },
      detail: `Session ${ctx.letter} (${ctx.session.device.connectionLabel}) shows spikes on ${target.address} recurring roughly every ${bestLag}s (autocorrelation ${round(bestCorr, 2)}, ${repetitions} repetitions across the session).`,
    },
  ];
}

// ---------------------------------------------------------------------------
// 7. burstiness
// ---------------------------------------------------------------------------

function burstinessFindings(
  ctx: SessionCtx,
  target: Target,
  samples: Sample[],
  thresholdMs: number,
): Finding[] {
  const spikes = detectSpikes(samples, thresholdMs);
  if (spikes.length < 6) return [];

  const starts = spikes.map((s) => s.startUtcMs).sort((a, b) => a - b);
  const intervals: number[] = [];
  for (let i = 1; i < starts.length; i += 1) intervals.push((starts[i] - starts[i - 1]) / 1000);

  const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
  if (mean <= 0) return [];
  const variance = intervals.reduce((a, v) => a + (v - mean) ** 2, 0) / intervals.length;
  const cv = Math.sqrt(variance) / mean;

  if (cv >= 1.5) {
    return [
      {
        id: `burstiness:${ctx.letter}:${target.address}`,
        severity: "notable",
        scope: { session: ctx.letter, targetAddress: target.address },
        title: `Session ${ctx.letter}: spikes clustered in bursts on ${target.address}`,
        metrics: { coefficientOfVariation: round(cv, 2), spikeCount: spikes.length },
        detail: `Session ${ctx.letter} (${ctx.session.device.connectionLabel}) spikes on ${target.address} are clustered in bursts rather than evenly spread (interval CV ${round(cv, 2)}).`,
      },
    ];
  }
  if (cv <= 0.4) {
    return [
      {
        id: `burstiness:${ctx.letter}:${target.address}`,
        severity: "notable",
        scope: { session: ctx.letter, targetAddress: target.address },
        title: `Session ${ctx.letter}: spikes strikingly regular on ${target.address}`,
        metrics: { coefficientOfVariation: round(cv, 2), spikeCount: spikes.length },
        detail: `Session ${ctx.letter} (${ctx.session.device.connectionLabel}) spikes on ${target.address} occur at strikingly regular intervals (interval CV ${round(cv, 2)}); cross-check against periodicity.`,
      },
    ];
  }
  return [];
}

// ---------------------------------------------------------------------------
// 8. providerContribution
// ---------------------------------------------------------------------------

function providerContributionFindings(ctx: SessionCtx, thresholdMs: number): Finding[] {
  const gateway = ctx.session.targets.find((t) => t.kind === "gateway");
  const internetTargets = ctx.session.targets.filter((t) => t.kind === "internet");
  if (!gateway || internetTargets.length === 0) return [];

  const gatewayP95 = computeStats(samplesForTarget(ctx.session, gateway.id), thresholdMs).p95;
  const internetP95s = internetTargets
    .map((t) => computeStats(samplesForTarget(ctx.session, t.id), thresholdMs).p95)
    .filter((p): p is number => p !== null);
  if (gatewayP95 === null || internetP95s.length === 0) return [];

  const minInternetP95 = Math.min(...internetP95s);
  const deltaP95 = minInternetP95 - gatewayP95;

  if (gatewayP95 <= 20 && deltaP95 >= 50) {
    return [
      {
        id: `provider-contribution:${ctx.letter}`,
        severity: "warning",
        scope: { session: ctx.letter },
        title: `Session ${ctx.letter}: upstream adds ${round(deltaP95, 0)}ms beyond the gateway`,
        metrics: { gatewayP95Ms: round(gatewayP95, 1), minInternetP95Ms: round(minInternetP95, 1), deltaP95Ms: round(deltaP95, 1) },
        detail: `Session ${ctx.letter} (${ctx.session.device.connectionLabel}) has a clean gateway (p95 ${round(gatewayP95, 1)} ms) but the best internet target adds ${round(deltaP95, 0)} ms on top (p95 ${round(minInternetP95, 1)} ms), pointing at the provider/upstream path.`,
      },
    ];
  }
  if (gatewayP95 >= 50) {
    return [
      {
        id: `provider-contribution:${ctx.letter}`,
        severity: "warning",
        scope: { session: ctx.letter },
        title: `Session ${ctx.letter}: local link dominates (gateway p95 ${round(gatewayP95, 0)}ms)`,
        metrics: { gatewayP95Ms: round(gatewayP95, 1), minInternetP95Ms: round(minInternetP95, 1), deltaP95Ms: round(deltaP95, 1) },
        detail: `Session ${ctx.letter} (${ctx.session.device.connectionLabel}) already has a slow local link to the gateway (p95 ${round(gatewayP95, 1)} ms), so the local link is the dominant contributor to latency.`,
      },
    ];
  }
  return [];
}

// ---------------------------------------------------------------------------
// 9. targetAsymmetry
// ---------------------------------------------------------------------------

function targetAsymmetryFindings(ctx: SessionCtx, thresholdMs: number): Finding[] {
  const internetTargets = ctx.session.targets.filter((t) => t.kind === "internet");
  if (internetTargets.length < 2) return [];

  const withP95 = internetTargets
    .map((t) => ({ target: t, p95: computeStats(samplesForTarget(ctx.session, t.id), thresholdMs).p95 }))
    .filter((x): x is { target: Target; p95: number } => x.p95 !== null);
  if (withP95.length < 2) return [];

  let best = withP95[0];
  let worst = withP95[0];
  for (const entry of withP95) {
    if (entry.p95 < best.p95) best = entry;
    if (entry.p95 > worst.p95) worst = entry;
  }
  if (best.target.address === worst.target.address) return [];

  const diff = worst.p95 - best.p95;
  const ratio = best.p95 > 0 ? worst.p95 / best.p95 : Infinity;
  if (ratio >= 1.8 && diff >= 15) {
    return [
      {
        id: `target-asymmetry:${ctx.letter}`,
        severity: "notable",
        scope: { session: ctx.letter },
        title: `Session ${ctx.letter}: routes differ (${worst.target.address} vs ${best.target.address})`,
        metrics: {
          worstAddress: worst.target.address,
          worstP95Ms: round(worst.p95, 1),
          bestAddress: best.target.address,
          bestP95Ms: round(best.p95, 1),
          ratio: round(ratio, 2),
        },
        detail: `Session ${ctx.letter} (${ctx.session.device.connectionLabel}) reaches ${worst.target.address} at p95 ${round(worst.p95, 1)} ms versus ${round(best.p95, 1)} ms for ${best.target.address} (${round(ratio, 1)}x), suggesting routing asymmetry between internet targets.`,
      },
    ];
  }
  return [];
}

// ---------------------------------------------------------------------------
// 10. crossSessionComparison
// ---------------------------------------------------------------------------

function crossSessionComparisonFindings(
  ctxA: SessionCtx,
  ctxB: SessionCtx,
  address: string,
  thresholdMs: number,
): Finding[] {
  const targetA = targetByAddress(ctxA.session, address);
  const targetB = targetByAddress(ctxB.session, address);
  if (!targetA || !targetB) return [];

  const statsA = computeStats(samplesForTarget(ctxA.session, targetA.id), thresholdMs);
  const statsB = computeStats(samplesForTarget(ctxB.session, targetB.id), thresholdMs);

  let worseLetter: SessionLetter | null = null;
  let reason: "p95" | "loss" | null = null;

  if (statsA.p95 !== null && statsB.p95 !== null) {
    const worseIsA = statsA.p95 >= statsB.p95;
    const worseP95 = worseIsA ? statsA.p95 : statsB.p95;
    const betterP95 = worseIsA ? statsB.p95 : statsA.p95;
    const diff = worseP95 - betterP95;
    const ratio = betterP95 > 0 ? worseP95 / betterP95 : worseP95 > 0 ? Infinity : 1;
    if (ratio >= 1.5 && diff >= 10) {
      worseLetter = worseIsA ? "A" : "B";
      reason = "p95";
    }
  }
  if (!worseLetter) {
    const lossDiff = Math.abs(statsA.lossPct - statsB.lossPct);
    if (lossDiff >= 2) {
      worseLetter = statsA.lossPct >= statsB.lossPct ? "A" : "B";
      reason = "loss";
    }
  }

  const metrics: Record<string, number | string> = {
    aP95Ms: statsA.p95 ?? -1,
    bP95Ms: statsB.p95 ?? -1,
    aJitterMs: statsA.jitterMs ?? -1,
    bJitterMs: statsB.jitterMs ?? -1,
    aLossPct: round(statsA.lossPct, 2),
    bLossPct: round(statsB.lossPct, 2),
  };

  if (worseLetter) {
    const title =
      reason === "p95"
        ? `${address}: Session ${worseLetter} has the worse p95`
        : `${address}: Session ${worseLetter} has more packet loss`;
    return [
      {
        id: `cross-session:${address}`,
        severity: "warning",
        scope: { session: "both", targetAddress: address },
        title,
        metrics,
        detail: `On ${address}, Session ${worseLetter} (${(worseLetter === "A" ? ctxA : ctxB).session.device.connectionLabel}) is meaningfully worse than the other session (p95 A=${statsA.p95 ?? "n/a"}ms, B=${statsB.p95 ?? "n/a"}ms; loss A=${round(statsA.lossPct, 2)}%, B=${round(statsB.lossPct, 2)}%).`,
      },
    ];
  }

  return [
    {
      id: `cross-session:${address}`,
      severity: "info",
      scope: { session: "both", targetAddress: address },
      title: `${address}: comparable across sessions`,
      metrics,
      detail: `On ${address}, Session A and Session B show comparable performance (p95 A=${statsA.p95 ?? "n/a"}ms, B=${statsB.p95 ?? "n/a"}ms; loss A=${round(statsA.lossPct, 2)}%, B=${round(statsB.lossPct, 2)}%).`,
    },
  ];
}

// ---------------------------------------------------------------------------
// 11. simultaneousSpikes
// ---------------------------------------------------------------------------

const CO_OCCURRENCE_BUCKET_MS = 5000;

function spikeBucketKeys(
  spikes: SpikeEvent[],
  overlapStart: number,
  overlapEnd: number,
): Set<number> {
  const keys = new Set<number>();
  for (const spike of spikes) {
    const startKey = Math.floor(spike.startUtcMs / CO_OCCURRENCE_BUCKET_MS) * CO_OCCURRENCE_BUCKET_MS;
    const endKey = Math.floor(spike.endUtcMs / CO_OCCURRENCE_BUCKET_MS) * CO_OCCURRENCE_BUCKET_MS;
    for (let key = startKey; key <= endKey; key += CO_OCCURRENCE_BUCKET_MS) {
      if (key + CO_OCCURRENCE_BUCKET_MS > overlapStart && key < overlapEnd) keys.add(key);
    }
  }
  return keys;
}

function simultaneousSpikesFindings(
  ctxA: SessionCtx,
  ctxB: SessionCtx,
  commonAddresses: string[],
  thresholdMs: number,
): Finding[] {
  const overlapStart = Math.max(ctxA.session.startedUtcMs, ctxB.session.startedUtcMs);
  const overlapEnd = Math.min(sessionEndMs(ctxA.session), sessionEndMs(ctxB.session));
  const overlapMs = overlapEnd - overlapStart;
  if (overlapMs < 60_000) return [];

  const findings: Finding[] = [];
  for (const address of commonAddresses) {
    const targetA = targetByAddress(ctxA.session, address);
    const targetB = targetByAddress(ctxB.session, address);
    if (!targetA || !targetB) continue;

    const spikesA = detectSpikes(samplesForTarget(ctxA.session, targetA.id), thresholdMs);
    const spikesB = detectSpikes(samplesForTarget(ctxB.session, targetB.id), thresholdMs);
    const keysA = spikeBucketKeys(spikesA, overlapStart, overlapEnd);
    const keysB = spikeBucketKeys(spikesB, overlapStart, overlapEnd);
    if (keysA.size === 0 || keysB.size === 0) continue;

    let intersection = 0;
    for (const key of keysA) if (keysB.has(key)) intersection += 1;
    const coOccurrence = intersection / Math.min(keysA.size, keysB.size);

    const metrics: Record<string, number | string> = {
      coOccurrence: round(coOccurrence, 2),
      aSpikeBuckets: keysA.size,
      bSpikeBuckets: keysB.size,
      overlapSec: Math.round(overlapMs / 1000),
    };

    if (keysA.size >= 3 && keysB.size >= 3 && coOccurrence >= 0.5) {
      findings.push({
        id: `simultaneous-spikes:${address}`,
        severity: "critical",
        scope: { session: "both", targetAddress: address },
        title: `${address}: spikes hit both machines at the same moments`,
        metrics,
        detail: `On ${address}, ${round(coOccurrence * 100, 0)}% of Session A's and B's spike windows coincide within the ${overlapMs / 1000}s overlap, a strong shared-cause signal (e.g. router or upstream provider).`,
      });
    } else if (coOccurrence <= 0.15) {
      findings.push({
        id: `simultaneous-spikes:${address}`,
        severity: "notable",
        scope: { session: "both", targetAddress: address },
        title: `${address}: spikes are independent`,
        metrics,
        detail: `On ${address}, Session A's and B's spikes rarely coincide (${round(coOccurrence * 100, 0)}% co-occurrence) during the ${overlapMs / 1000}s overlap, suggesting independent, machine-local causes.`,
      });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

export function analyzeComparison(input: FindingsInput): Finding[] {
  const thresholdMs = input.spikeThresholdMs ?? DEFAULT_SPIKE_THRESHOLD_MS;
  const ctxA = makeCtx("A", input.a);
  const ctxB = makeCtx("B", input.b);

  const findings: Finding[] = [];

  for (const ctx of [ctxA, ctxB]) {
    for (const target of ctx.session.targets) {
      const samples = samplesForTarget(ctx.session, target.id);
      findings.push(...spikeRateFindings(ctx, target, samples, thresholdMs));
      findings.push(...spikeSeverityFindings(ctx, target, samples, thresholdMs));
      findings.push(...packetLossFindings(ctx, target, samples, thresholdMs));
      findings.push(...worstStretchFindings(ctx, target, samples, thresholdMs));
      findings.push(...periodicityFindings(ctx, target, samples, thresholdMs));
      findings.push(...burstinessFindings(ctx, target, samples, thresholdMs));
    }
    findings.push(...timeAboveThresholdsFindings(ctx));
    findings.push(...providerContributionFindings(ctx, thresholdMs));
    findings.push(...targetAsymmetryFindings(ctx, thresholdMs));
  }

  const common = commonTargetAddresses(input.a, input.b);
  for (const address of common) {
    findings.push(...crossSessionComparisonFindings(ctxA, ctxB, address, thresholdMs));
  }
  findings.push(...simultaneousSpikesFindings(ctxA, ctxB, common, thresholdMs));

  findings.sort((x, y) => SEVERITY_RANK[x.severity] - SEVERITY_RANK[y.severity]);
  return findings.slice(0, MAX_FINDINGS);
}
