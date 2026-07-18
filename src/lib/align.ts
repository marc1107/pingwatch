import type { AlignedPoint, Sample, Session } from "./types";

/**
 * Group samples into fixed time buckets: average successful RTTs and record
 * the loss share per bucket. Bucket timestamps are floor-aligned to
 * `bucketMs` so equal wall-clock instants land in equal buckets across
 * sessions from different machines.
 */
export function bucketize(samples: Sample[], bucketMs: number): AlignedPoint[] {
  const buckets = new Map<number, { sum: number; ok: number; loss: number }>();
  for (const sample of samples) {
    const key = Math.floor(sample.tUtcMs / bucketMs) * bucketMs;
    const bucket = buckets.get(key) ?? { sum: 0, ok: 0, loss: 0 };
    if (sample.rttMs === null) {
      bucket.loss += 1;
    } else {
      bucket.sum += sample.rttMs;
      bucket.ok += 1;
    }
    buckets.set(key, bucket);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([tUtcMs, { sum, ok, loss }]) => ({
      tUtcMs,
      avgRttMs: ok > 0 ? sum / ok : null,
      lossPct: (loss / (ok + loss)) * 100,
    }));
}

export interface AlignedSessions {
  /** "absolute": buckets share real UTC time. "relative": rebased to elapsed ms from each session's start (no overlap). */
  mode: "absolute" | "relative";
  overlapMs: number;
  a: AlignedPoint[];
  b: AlignedPoint[];
}

function sessionEnd(session: Session): number {
  return (
    session.endedUtcMs ??
    session.samples.reduce((max, sample) => Math.max(max, sample.tUtcMs), session.startedUtcMs)
  );
}

/**
 * Align two sessions for comparison. If their recording windows overlap in
 * absolute UTC time, buckets keep real timestamps; otherwise both are
 * rebased onto time-since-session-start so their shapes remain comparable.
 */
export function alignSessions(a: Session, b: Session, bucketMs = 1000): AlignedSessions {
  const overlapStart = Math.max(a.startedUtcMs, b.startedUtcMs);
  const overlapEnd = Math.min(sessionEnd(a), sessionEnd(b));
  const overlapMs = Math.max(0, overlapEnd - overlapStart);

  if (overlapMs > 0) {
    return {
      mode: "absolute",
      overlapMs,
      a: bucketize(a.samples, bucketMs),
      b: bucketize(b.samples, bucketMs),
    };
  }

  const rebase = (session: Session): Sample[] =>
    session.samples.map((sample) => ({
      ...sample,
      tUtcMs: sample.tUtcMs - session.startedUtcMs,
    }));

  return {
    mode: "relative",
    overlapMs: 0,
    a: bucketize(rebase(a), bucketMs),
    b: bucketize(rebase(b), bucketMs),
  };
}
