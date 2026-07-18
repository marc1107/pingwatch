import { describe, expect, it } from "vitest";
import { computeStats, detectSpikes, healthOf } from "./stats";
import type { Sample } from "./types";

const s = (seq: number, rttMs: number | null, tUtcMs = seq * 500): Sample => ({
  targetId: "t1",
  seq,
  tUtcMs,
  rttMs,
});

describe("computeStats", () => {
  it("returns null metrics for no samples", () => {
    const stats = computeStats([], 100);
    expect(stats.count).toBe(0);
    expect(stats.avg).toBeNull();
    expect(stats.min).toBeNull();
    expect(stats.p95).toBeNull();
    expect(stats.jitterMs).toBeNull();
    expect(stats.current).toBeNull();
    expect(stats.lossPct).toBe(0);
  });

  it("computes basic aggregates", () => {
    const stats = computeStats([s(0, 10), s(1, 20), s(2, 30)], 100);
    expect(stats.count).toBe(3);
    expect(stats.min).toBe(10);
    expect(stats.max).toBe(30);
    expect(stats.avg).toBeCloseTo(20);
    expect(stats.current).toBe(30);
    expect(stats.lossCount).toBe(0);
  });

  it("counts losses and excludes them from rtt aggregates", () => {
    const stats = computeStats([s(0, 10), s(1, null), s(2, 30), s(3, null)], 100);
    expect(stats.lossCount).toBe(2);
    expect(stats.lossPct).toBeCloseTo(50);
    expect(stats.avg).toBeCloseTo(20);
    expect(stats.current).toBeNull(); // latest sample was lost
  });

  it("computes nearest-rank percentiles", () => {
    const samples = Array.from({ length: 100 }, (_, i) => s(i, i + 1));
    const stats = computeStats(samples, 1000);
    expect(stats.p95).toBe(95);
    expect(stats.p99).toBe(99);
  });

  it("computes jitter as mean absolute successive difference", () => {
    // diffs: |20-10|=10, |15-20|=5 -> mean 7.5; losses break the chain
    const stats = computeStats([s(0, 10), s(1, 20), s(2, null), s(3, 15)], 100);
    expect(stats.jitterMs).toBeCloseTo(10); // only 10-20 are successive
  });

  it("counts spikes above threshold", () => {
    const stats = computeStats([s(0, 10), s(1, 150), s(2, 20), s(3, 250)], 100);
    expect(stats.spikeCount).toBe(2);
  });
});

describe("healthOf", () => {
  const base = computeStats(
    Array.from({ length: 50 }, (_, i) => s(i, 15 + (i % 3))),
    100,
  );

  it("rates steady low latency as good", () => {
    expect(healthOf(base)).toBe("good");
  });

  it("rates high p95 as bad", () => {
    const stats = { ...base, p95: 140 };
    expect(healthOf(stats)).toBe("bad");
  });

  it("rates mild loss as warn", () => {
    const stats = { ...base, lossPct: 1 };
    expect(healthOf(stats)).toBe("warn");
  });

  it("rates heavy loss as bad", () => {
    const stats = { ...base, lossPct: 5 };
    expect(healthOf(stats)).toBe("bad");
  });

  it("rates unknown stats as warn", () => {
    expect(healthOf(computeStats([], 100))).toBe("warn");
  });
});

describe("detectSpikes", () => {
  it("returns no events for calm samples", () => {
    expect(detectSpikes([s(0, 10), s(1, 12)], 100)).toEqual([]);
  });

  it("merges contiguous bad samples into one event", () => {
    const events = detectSpikes(
      [s(0, 10), s(1, 150), s(2, 300), s(3, null), s(4, 12)],
      100,
    );
    expect(events).toHaveLength(1);
    expect(events[0].startUtcMs).toBe(500);
    expect(events[0].endUtcMs).toBe(1500);
    expect(events[0].peakRttMs).toBe(300);
    expect(events[0].sampleCount).toBe(3);
    expect(events[0].hasLoss).toBe(true);
  });

  it("reports pure-loss spikes with null peak", () => {
    const events = detectSpikes([s(0, 10), s(1, null), s(2, 11)], 100);
    expect(events).toHaveLength(1);
    expect(events[0].peakRttMs).toBeNull();
    expect(events[0].hasLoss).toBe(true);
  });

  it("separates events split by good samples", () => {
    const events = detectSpikes([s(0, 200), s(1, 10), s(2, 200)], 100);
    expect(events).toHaveLength(2);
  });
});
