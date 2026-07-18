import { describe, expect, it } from "vitest";
import { alignSessions, bucketize } from "./align";
import type { Sample, Session } from "./types";

const sample = (targetId: string, tUtcMs: number, rttMs: number | null): Sample => ({
  targetId,
  seq: 0,
  tUtcMs,
  rttMs,
});

const session = (startedUtcMs: number, samples: Sample[]): Session => ({
  schemaVersion: 1,
  id: `s-${startedUtcMs}`,
  startedUtcMs,
  endedUtcMs: startedUtcMs + 60_000,
  intervalMs: 500,
  timeoutMs: 1000,
  timezone: "UTC",
  device: { hostname: "h", os: "macos", connectionLabel: "Wi-Fi" },
  targets: [{ id: "t1", label: "DNS", address: "1.1.1.1", kind: "internet" }],
  samples,
});

describe("bucketize", () => {
  it("averages rtt per bucket and computes loss share", () => {
    const points = bucketize(
      [
        sample("t1", 1000, 10),
        sample("t1", 1400, 20),
        sample("t1", 1900, null),
        sample("t1", 2100, 40),
      ],
      1000,
    );
    expect(points).toHaveLength(2);
    expect(points[0]).toEqual({ tUtcMs: 1000, avgRttMs: 15, lossPct: expect.closeTo(33.33, 1) });
    expect(points[1]).toEqual({ tUtcMs: 2000, avgRttMs: 40, lossPct: 0 });
  });

  it("emits null avg for all-loss buckets", () => {
    const points = bucketize([sample("t1", 500, null)], 1000);
    expect(points[0].avgRttMs).toBeNull();
    expect(points[0].lossPct).toBe(100);
  });
});

describe("alignSessions", () => {
  it("reports the UTC overlap and aligned buckets when sessions overlap", () => {
    const a = session(0, [sample("t1", 10_000, 10), sample("t1", 20_000, 12)]);
    const b = session(5_000, [sample("t1", 12_000, 30), sample("t1", 20_500, 35)]);
    const result = alignSessions(a, b, 1000);
    expect(result.overlapMs).toBeGreaterThan(0);
    expect(result.mode).toBe("absolute");
    // Both sessions have a bucket at 20s.
    const aAt20 = result.a.find((p) => p.tUtcMs === 20_000);
    const bAt20 = result.b.find((p) => p.tUtcMs === 20_000);
    expect(aAt20?.avgRttMs).toBe(12);
    expect(bAt20?.avgRttMs).toBe(35);
  });

  it("falls back to relative time when sessions do not overlap", () => {
    const a = session(0, [sample("t1", 1_000, 10)]);
    const b = session(3_600_000, [sample("t1", 3_601_000, 30)]);
    const result = alignSessions(a, b, 1000);
    expect(result.overlapMs).toBe(0);
    expect(result.mode).toBe("relative");
    // Relative mode rebases both sessions onto elapsed-ms-from-start.
    expect(result.a[0].tUtcMs).toBe(1000);
    expect(result.b[0].tUtcMs).toBe(1000);
  });
});
