import type { Health, Sample, SpikeEvent, TargetStats } from "./types";

/** Nearest-rank percentile on a pre-sorted ascending array. */
function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1];
}

export function computeStats(samples: Sample[], spikeThresholdMs: number): TargetStats {
  const count = samples.length;
  const rtts: number[] = [];
  let lossCount = 0;
  let jitterSum = 0;
  let jitterPairs = 0;
  let spikeCount = 0;
  let prevRtt: number | null = null;

  for (const sample of samples) {
    if (sample.rttMs === null) {
      lossCount += 1;
      prevRtt = null; // losses break the successive-difference chain
      continue;
    }
    rtts.push(sample.rttMs);
    if (sample.rttMs > spikeThresholdMs) spikeCount += 1;
    if (prevRtt !== null) {
      jitterSum += Math.abs(sample.rttMs - prevRtt);
      jitterPairs += 1;
    }
    prevRtt = sample.rttMs;
  }

  const sorted = [...rtts].sort((a, b) => a - b);
  const latest = samples.at(-1);

  return {
    count,
    lossCount,
    lossPct: count === 0 ? 0 : (lossCount / count) * 100,
    min: sorted.length ? sorted[0] : null,
    avg: sorted.length ? rtts.reduce((a, b) => a + b, 0) / rtts.length : null,
    max: sorted.length ? sorted[sorted.length - 1] : null,
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    jitterMs: jitterPairs > 0 ? jitterSum / jitterPairs : null,
    spikeCount,
    current: latest?.rttMs ?? null,
  };
}

/** Gaming-oriented link health rating. */
export function healthOf(stats: TargetStats): Health {
  const { lossPct, p95, jitterMs } = stats;
  if (p95 === null || jitterMs === null) return "warn"; // not enough data
  if (lossPct > 2 || p95 > 100 || jitterMs > 30) return "bad";
  if (lossPct > 0.5 || p95 > 60 || jitterMs > 15) return "warn";
  return "good";
}

/**
 * Collapse contiguous runs of bad samples (rtt above threshold or loss)
 * into discrete spike events for the event log.
 */
export function detectSpikes(samples: Sample[], thresholdMs: number): SpikeEvent[] {
  const events: SpikeEvent[] = [];
  let open: SpikeEvent | null = null;

  for (const sample of samples) {
    const bad = sample.rttMs === null || sample.rttMs > thresholdMs;
    if (!bad) {
      if (open) events.push(open);
      open = null;
      continue;
    }
    if (!open) {
      open = {
        startUtcMs: sample.tUtcMs,
        endUtcMs: sample.tUtcMs,
        peakRttMs: sample.rttMs,
        sampleCount: 1,
        hasLoss: sample.rttMs === null,
      };
      continue;
    }
    open.endUtcMs = sample.tUtcMs;
    open.sampleCount += 1;
    if (sample.rttMs === null) {
      open.hasLoss = true;
    } else if (open.peakRttMs === null || sample.rttMs > open.peakRttMs) {
      open.peakRttMs = sample.rttMs;
    }
  }
  if (open) events.push(open);
  return events;
}
