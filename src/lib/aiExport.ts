import { computeStats, detectSpikes } from "./stats";
import type { Sample, Session, SpikeEvent, TargetStats } from "./types";

/**
 * Verbatim analysis prompt prepended to every AI export. Instructs the
 * receiving model (Claude/ChatGPT) how to read the JSON payload below it and
 * what self-contained HTML report to produce from it.
 */
const ANALYSIS_PROMPT = `You are a network diagnostics expert. Below (after the \`=== DATA (JSON) ===\` marker) you will find latency recordings from the tool PingWatch: two monitoring sessions, usually from two different machines on the same home network (for example one on Wi-Fi and one on wired LAN behind the same router). Each session pinged several targets simultaneously — typically the router gateway plus internet hosts — and contains per-target summary statistics, the most severe spike events, and a downsampled time series (buckets of [secondsSinceStart, avgMs, maxMs, lostPings]; a null avg means every ping in that bucket was lost).

Your task: compare the two sessions in depth and produce your answer as a SINGLE, fully self-contained HTML file (inline CSS and inline SVG or canvas charts only — no external scripts, stylesheets, fonts or network requests) that the user can save and open locally. If your environment supports rendering an HTML artifact, render it as one.

The report must contain at least:
1. An executive summary at the top: 2–4 sentences naming which connection is better for real-time gaming and why, plus a confidence level (high/medium/low) with a one-line justification.
2. A verdict on WHERE any problem lives, using this reasoning: latency/loss to the router gateway reflects the local link (Wi-Fi or cable) only; latency to internet hosts includes gateway + provider. If the gateway is clean but internet targets are bad on both machines, suspect the provider or routing. If one machine is bad everywhere including the gateway, suspect that machine's link. Say explicitly which case applies here.
3. Side-by-side comparison visuals: overlaid or mirrored time-series charts per common target (label axes in ms and minutes), and a compact table of avg / p95 / p99 / max / jitter / loss% / spikes-per-minute per target and session, highlighting the worse value of each pair.
4. Spike analysis: how often spikes occur (rate per minute), how long they last, how severe they are (peak distribution), and whether they cluster in time (bursts) or spread evenly. Note any periodicity you can detect from the bucket data (e.g. a spike every ~100 s).
5. Gaming impact: translate the findings into effect on fast online games (rule of thumb: sustained <50 ms good, spikes >100 ms cause visible stutter, loss >1% causes rubber-banding; jitter matters more than average).
6. Concrete, prioritized recommendations (max 5) specific to what the data shows.

Important analytical guidance — but do not limit yourself to it:
- The two sessions may cover DIFFERENT time ranges or lengths. If they overlap in absolute time (compare startedUtc/durationSec), align on absolute time and say whether simultaneous spikes occur on both machines (strong router/provider signal). If they do not overlap, compare distributions and rates instead of moments, and clearly state this limitation and its effect on your confidence.
- Normalize by duration wherever you compare counts (per-minute rates, not totals), since sessions may differ in length and ping interval.
- Look beyond the provided aggregates: derive whatever additional measures help — e.g. highest values, share of time above thresholds (50/100/200 ms), worst continuous stretch, gateway-vs-internet deltas within each session (which isolates the provider's contribution), differences between the two internet targets (routing asymmetries).
- You decide which differences are relevant. If you find something noteworthy that these instructions did not anticipate, include it. If the data is insufficient for a firm conclusion, say what additional measurement would settle it (e.g. longer run, simultaneous run, wired reference).
- All numbers you show must come from the data below — never invent values. Round sensibly.`;

export type BucketRow = [tOffsetSec: number, avg: number | null, max: number | null, lossCount: number];

export interface TargetBuckets {
  targetId: string;
  bucketMs: number;
  buckets: BucketRow[];
}

/** Session end time: explicit end, or the last sample's timestamp, or the start if there are no samples. */
function sessionEndMs(session: Session): number {
  return (
    session.endedUtcMs ??
    session.samples.reduce((max, sample) => Math.max(max, sample.tUtcMs), session.startedUtcMs)
  );
}

/**
 * Downsample every target's samples into fixed-size buckets relative to the
 * session start, keeping the token cost of an export bounded regardless of
 * recording length. Bucket size grows adaptively so that each target never
 * exceeds `maxBucketsPerTarget` buckets.
 */
export function downsampleSession(session: Session, maxBucketsPerTarget = 240): TargetBuckets[] {
  const durationMs = Math.max(0, sessionEndMs(session) - session.startedUtcMs);
  const bucketMs = Math.max(1000, Math.ceil(durationMs / maxBucketsPerTarget / 1000) * 1000);

  return session.targets.map((target) => {
    const buckets = new Map<number, { sum: number; ok: number; max: number; loss: number }>();
    for (const sample of session.samples) {
      if (sample.targetId !== target.id) continue;
      const key = Math.floor((sample.tUtcMs - session.startedUtcMs) / bucketMs);
      const bucket = buckets.get(key) ?? { sum: 0, ok: 0, max: -Infinity, loss: 0 };
      if (sample.rttMs === null) {
        bucket.loss += 1;
      } else {
        bucket.sum += sample.rttMs;
        bucket.ok += 1;
        if (sample.rttMs > bucket.max) bucket.max = sample.rttMs;
      }
      buckets.set(key, bucket);
    }

    const rows: BucketRow[] = [...buckets.entries()]
      .sort(([a], [b]) => a - b)
      .map(([key, { sum, ok, max, loss }]) => [
        Math.round((key * bucketMs) / 1000),
        ok > 0 ? Math.round((sum / ok) * 10) / 10 : null,
        ok > 0 ? Math.round(max * 10) / 10 : null,
        loss,
      ]);

    return { targetId: target.id, bucketMs, buckets: rows };
  });
}

function round2(v: number | null): number | null {
  return v === null ? null : Math.round(v * 100) / 100;
}

function roundStats(stats: TargetStats): TargetStats {
  return {
    ...stats,
    lossPct: round2(stats.lossPct) ?? 0,
    min: round2(stats.min),
    avg: round2(stats.avg),
    max: round2(stats.max),
    p95: round2(stats.p95),
    p99: round2(stats.p99),
    jitterMs: round2(stats.jitterMs),
    current: round2(stats.current),
  };
}

interface ExportSpike {
  startOffsetSec: number;
  durationSec: number;
  peakMs: number | null;
  samples: number;
  hasLoss: boolean;
}

const MAX_SPIKES = 25;

function exportSpikes(events: SpikeEvent[], session: Session): ExportSpike[] {
  const severity = (e: SpikeEvent) => (e.peakRttMs === null ? Infinity : e.peakRttMs);
  return [...events]
    .sort((a, b) => severity(b) - severity(a))
    .slice(0, MAX_SPIKES)
    .map((e) => ({
      startOffsetSec: Math.round((e.startUtcMs - session.startedUtcMs) / 1000),
      durationSec: Math.round(((e.endUtcMs - e.startUtcMs) / 1000) * 10) / 10,
      peakMs: e.peakRttMs === null ? null : Math.round(e.peakRttMs * 10) / 10,
      samples: e.sampleCount,
      hasLoss: e.hasLoss,
    }));
}

const SPIKE_THRESHOLD_MS = 100;

function samplesForTarget(session: Session, targetId: string): Sample[] {
  return session.samples.filter((s) => s.targetId === targetId);
}

function exportSession(session: Session) {
  const buckets = downsampleSession(session);
  const bucketsByTarget = new Map(buckets.map((b) => [b.targetId, b]));
  const endMs = sessionEndMs(session);

  return {
    label: session.device.connectionLabel,
    hostname: session.device.hostname,
    os: session.device.os,
    timezone: session.timezone,
    startedUtc: new Date(session.startedUtcMs).toISOString(),
    endedUtc: session.endedUtcMs === null ? null : new Date(session.endedUtcMs).toISOString(),
    durationSec: Math.round((endMs - session.startedUtcMs) / 1000),
    intervalMs: session.intervalMs,
    timeoutMs: session.timeoutMs,
    targets: session.targets.map((target) => {
      const samples = samplesForTarget(session, target.id);
      const tb = bucketsByTarget.get(target.id);
      return {
        label: target.label,
        address: target.address,
        kind: target.kind,
        stats: roundStats(computeStats(samples, SPIKE_THRESHOLD_MS)),
        spikes: exportSpikes(detectSpikes(samples, SPIKE_THRESHOLD_MS), session),
        bucketMs: tb?.bucketMs ?? 1000,
        buckets: tb?.buckets ?? [],
      };
    }),
  };
}

/**
 * Build the full self-contained export blob: the analysis prompt template
 * followed by a compact JSON payload for both compared sessions. Meant to be
 * copied verbatim into an AI chat.
 */
export function buildAiExport(a: Session, b: Session): string {
  const payload = {
    format: "pingwatch-ai-export/1",
    sessions: [exportSession(a), exportSession(b)],
  };
  return `${ANALYSIS_PROMPT}\n\n=== DATA (JSON) ===\n${JSON.stringify(payload)}`;
}
