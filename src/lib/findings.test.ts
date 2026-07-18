import { describe, expect, it } from "vitest";
import { analyzeComparison } from "./findings";
import type { Sample, Session, Target } from "./types";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function mkTarget(address: string, kind: Target["kind"] = "internet"): Target {
  return { id: address, label: address, address, kind };
}

function seriesFromRtts(targetId: string, startUtcMs: number, intervalMs: number, rtts: (number | null)[]): Sample[] {
  return rtts.map((rttMs, i) => ({ targetId, seq: i, tUtcMs: startUtcMs + i * intervalMs, rttMs }));
}

function mkSession(opts: {
  startedUtcMs?: number;
  endedUtcMs?: number | null;
  intervalMs?: number;
  connectionLabel?: string;
  targets: Target[];
  samples: Sample[];
}): Session {
  return {
    schemaVersion: 1,
    id: `s-${opts.startedUtcMs ?? 0}-${opts.samples.length}`,
    startedUtcMs: opts.startedUtcMs ?? 0,
    endedUtcMs: opts.endedUtcMs === undefined ? null : opts.endedUtcMs,
    intervalMs: opts.intervalMs ?? 1000,
    timeoutMs: 1000,
    timezone: "UTC",
    device: { hostname: "host", os: "macos", connectionLabel: opts.connectionLabel ?? "Wi-Fi" },
    targets: opts.targets,
    samples: opts.samples,
  };
}

/** A trivial, mostly-empty session used as the "other side" of a comparison when a test only cares about session A. */
function emptySession(address = "0.0.0.0", startedUtcMs = 0, durationMs = 60_000): Session {
  return mkSession({
    startedUtcMs,
    endedUtcMs: startedUtcMs + durationMs,
    targets: [mkTarget(address)],
    samples: [],
  });
}

function severityOf(results: ReturnType<typeof analyzeComparison>, id: string): string | undefined {
  return results.find((f) => f.id === id)?.severity;
}

// ---------------------------------------------------------------------------
// 1. spikeRate
// ---------------------------------------------------------------------------

describe("spikeRate", () => {
  function sessionWithSpikeEvents(address: string, totalSamples: number, durationMs: number, spikeIndices: number[]): Session {
    const rtts = Array.from({ length: totalSamples }, (_, i) => (spikeIndices.includes(i) ? 999 : 10));
    return mkSession({
      startedUtcMs: 0,
      endedUtcMs: durationMs,
      targets: [mkTarget(address)],
      samples: seriesFromRtts(address, 0, 1000, rtts),
    });
  }

  it("rates >=1 spike/min as critical", () => {
    const a = sessionWithSpikeEvents("r1", 60, 60_000, [30]); // 1 event / 1 min = 1.0
    const results = analyzeComparison({ a, b: emptySession("other-a") });
    expect(severityOf(results, "spike-rate:A:r1")).toBe("critical");
  });

  it("rates >=0.3 spike/min as warning", () => {
    const a = sessionWithSpikeEvents("r2", 600, 600_000, [100, 300, 500]); // 3 events / 10 min = 0.3
    const results = analyzeComparison({ a, b: emptySession("other-b") });
    expect(severityOf(results, "spike-rate:A:r2")).toBe("warning");
  });

  it("rates >=0.05 spike/min as notable", () => {
    const a = sessionWithSpikeEvents("r3", 1200, 1_200_000, [600]); // 1 event / 20 min = 0.05
    const results = analyzeComparison({ a, b: emptySession("other-c") });
    expect(severityOf(results, "spike-rate:A:r3")).toBe("notable");
  });

  it("rates a small but nonzero rate as info", () => {
    const a = sessionWithSpikeEvents("r4", 1800, 1_800_000, [900]); // 1 event / 30 min = 0.033
    const results = analyzeComparison({ a, b: emptySession("other-d") });
    expect(severityOf(results, "spike-rate:A:r4")).toBe("info");
  });

  it("emits no finding when there are no spikes", () => {
    const a = sessionWithSpikeEvents("r5", 60, 60_000, []);
    const results = analyzeComparison({ a, b: emptySession("other-e") });
    expect(results.find((f) => f.id === "spike-rate:A:r5")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. spikeSeverity
// ---------------------------------------------------------------------------

describe("spikeSeverity", () => {
  function sessionWithEvents(address: string, eventRtts: (number | null)[][], gap = 5): Session {
    const rtts: (number | null)[] = [...Array(gap).fill(10)];
    for (const event of eventRtts) {
      rtts.push(...event);
      rtts.push(...Array(gap).fill(10));
    }
    return mkSession({
      startedUtcMs: 0,
      endedUtcMs: rtts.length * 1000,
      targets: [mkTarget(address)],
      samples: seriesFromRtts(address, 0, 1000, rtts),
    });
  }

  it("is a warning when the max peak reaches 400ms", () => {
    const a = sessionWithEvents("sv1", [[500], [120], [130]]);
    const results = analyzeComparison({ a, b: emptySession() });
    const finding = results.find((f) => f.id === "spike-severity:A:sv1");
    expect(finding?.severity).toBe("warning");
    expect(finding?.metrics.maxPeakMs).toBe(500);
  });

  it("is a warning when the longest event reaches 5 seconds even with a modest peak", () => {
    const a = sessionWithEvents("sv2", [[150, 150, 150, 150, 150, 150], [110], [110]]);
    const results = analyzeComparison({ a, b: emptySession() });
    const finding = results.find((f) => f.id === "spike-severity:A:sv2");
    expect(finding?.severity).toBe("warning");
    expect(finding?.metrics.longestEventSec).toBe(5);
  });

  it("is notable when the max peak is between 200 and 400ms", () => {
    const a = sessionWithEvents("sv3", [[250], [110], [120]]);
    const results = analyzeComparison({ a, b: emptySession() });
    expect(severityOf(results, "spike-severity:A:sv3")).toBe("notable");
  });

  it("is info for mild, short spikes", () => {
    const a = sessionWithEvents("sv4", [[110], [120], [130]]);
    const results = analyzeComparison({ a, b: emptySession() });
    expect(severityOf(results, "spike-severity:A:sv4")).toBe("info");
  });

  it("handles pure packet-loss spikes (no peak RTT) gracefully", () => {
    const a = sessionWithEvents("sv5", [[null], [null], [null]]);
    const results = analyzeComparison({ a, b: emptySession() });
    const finding = results.find((f) => f.id === "spike-severity:A:sv5");
    expect(finding?.severity).toBe("info");
    expect(finding?.metrics.maxPeakMs).toBeUndefined();
  });

  it("emits no finding for fewer than 3 spikes", () => {
    const a = sessionWithEvents("sv6", [[500], [500]]);
    const results = analyzeComparison({ a, b: emptySession() });
    expect(results.find((f) => f.id === "spike-severity:A:sv6")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. packetLoss
// ---------------------------------------------------------------------------

describe("packetLoss", () => {
  function sessionWithLoss(address: string, totalSamples: number, lossIndices: number[]): Session {
    const rtts = Array.from({ length: totalSamples }, (_, i) => (lossIndices.includes(i) ? null : 10));
    return mkSession({
      startedUtcMs: 0,
      endedUtcMs: totalSamples * 1000,
      targets: [mkTarget(address)],
      samples: seriesFromRtts(address, 0, 1000, rtts),
    });
  }

  it("rates >=2% loss as critical", () => {
    const a = sessionWithLoss("pl1", 100, [10, 60]); // 2%
    const results = analyzeComparison({ a, b: emptySession() });
    expect(severityOf(results, "packet-loss:A:pl1")).toBe("critical");
  });

  it("rates >=1% loss as warning", () => {
    const a = sessionWithLoss("pl2", 100, [10]); // 1%
    const results = analyzeComparison({ a, b: emptySession() });
    expect(severityOf(results, "packet-loss:A:pl2")).toBe("warning");
  });

  it("rates >=0.3% loss as notable", () => {
    const a = sessionWithLoss("pl3", 1000, [100, 500, 900]); // 0.3%
    const results = analyzeComparison({ a, b: emptySession() });
    expect(severityOf(results, "packet-loss:A:pl3")).toBe("notable");
  });

  it("rates a small but nonzero loss as info", () => {
    const a = sessionWithLoss("pl4", 1000, [500]); // 0.1%
    const results = analyzeComparison({ a, b: emptySession() });
    expect(severityOf(results, "packet-loss:A:pl4")).toBe("info");
  });

  it("emits no finding for zero loss", () => {
    const a = sessionWithLoss("pl5", 50, []);
    const results = analyzeComparison({ a, b: emptySession() });
    expect(results.find((f) => f.id === "packet-loss:A:pl5")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 4. timeAboveThresholds
// ---------------------------------------------------------------------------

describe("timeAboveThresholds", () => {
  it("reports the internet target with the worst >100ms share and excludes the gateway", () => {
    const mildRtts = Array.from({ length: 100 }, (_, i) => (i < 5 ? 150 : 10)); // 5% share100
    const severeRtts = Array.from({ length: 100 }, (_, i) => (i < 15 ? 150 : 10)); // 15% share100
    const gatewayRtts = Array.from({ length: 100 }, () => 500); // would dominate if counted

    const a = mkSession({
      startedUtcMs: 0,
      endedUtcMs: 100_000,
      targets: [mkTarget("mild", "internet"), mkTarget("severe", "internet"), mkTarget("gw", "gateway")],
      samples: [
        ...seriesFromRtts("mild", 0, 1000, mildRtts),
        ...seriesFromRtts("severe", 0, 1000, severeRtts),
        ...seriesFromRtts("gw", 0, 1000, gatewayRtts),
      ],
    });

    const results = analyzeComparison({ a, b: emptySession() });
    const findings = results.filter((f) => f.id.startsWith("time-above-threshold:A:"));
    expect(findings).toHaveLength(1);
    expect(findings[0].scope.targetAddress).toBe("severe");
    expect(findings[0].severity).toBe("critical");
    expect(findings[0].metrics.share100Pct).toBeCloseTo(15, 5);
  });

  it("emits no finding when no internet target ever crosses 100ms", () => {
    const a = mkSession({
      startedUtcMs: 0,
      endedUtcMs: 60_000,
      targets: [mkTarget("gw", "gateway"), mkTarget("net", "internet")],
      samples: [
        ...seriesFromRtts("gw", 0, 1000, Array.from({ length: 60 }, () => 500)),
        ...seriesFromRtts("net", 0, 1000, Array.from({ length: 60 }, () => 10)),
      ],
    });
    const results = analyzeComparison({ a, b: emptySession() });
    expect(results.find((f) => f.id.startsWith("time-above-threshold:A:"))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 5. worstStretch
// ---------------------------------------------------------------------------

describe("worstStretch", () => {
  function sessionWithOutage(address: string, totalSamples: number, outageIndices: number[]): Session {
    const rtts = Array.from({ length: totalSamples }, (_, i) => (outageIndices.includes(i) ? null : 10));
    return mkSession({
      startedUtcMs: 0,
      endedUtcMs: totalSamples * 1000,
      targets: [mkTarget(address)],
      samples: seriesFromRtts(address, 0, 1000, rtts),
    });
  }

  it("finds a planted 10s outage and rates it a warning", () => {
    const outageIndices = Array.from({ length: 10 }, (_, i) => 20 + i);
    const a = sessionWithOutage("ws1", 60, outageIndices);
    const results = analyzeComparison({ a, b: emptySession() });
    const finding = results.find((f) => f.id === "worst-stretch:A:ws1");
    expect(finding?.severity).toBe("warning");
    expect(finding?.metrics.durationSec).toBe(10);
    expect(finding?.metrics.startOffsetSec).toBe(20);
  });

  it("rates a stretch of 15s or more as critical", () => {
    const outageIndices = Array.from({ length: 20 }, (_, i) => 5 + i);
    const a = sessionWithOutage("ws2", 60, outageIndices);
    const results = analyzeComparison({ a, b: emptySession() });
    expect(severityOf(results, "worst-stretch:A:ws2")).toBe("critical");
  });

  it("ignores stretches shorter than 3 seconds", () => {
    const a = sessionWithOutage("ws3", 60, [20, 21]);
    const results = analyzeComparison({ a, b: emptySession() });
    expect(results.find((f) => f.id === "worst-stretch:A:ws3")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 6. periodicity
// ---------------------------------------------------------------------------

describe("periodicity", () => {
  it("detects a planted 30s spike cycle", () => {
    const totalSamples = 311;
    const spikeSeconds = Array.from({ length: 10 }, (_, i) => (i + 1) * 30); // 30,60,...,300
    const rtts = Array.from({ length: totalSamples }, (_, i) => (spikeSeconds.includes(i) ? 999 : 10));
    const a = mkSession({
      startedUtcMs: 0,
      endedUtcMs: totalSamples * 1000,
      targets: [mkTarget("per1")],
      samples: seriesFromRtts("per1", 0, 1000, rtts),
    });

    const results = analyzeComparison({ a, b: emptySession() });
    const finding = results.find((f) => f.id === "periodicity:A:per1");
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("notable");
    const lag = Number(finding?.metrics.lagSec);
    expect(lag).toBeGreaterThanOrEqual(28);
    expect(lag).toBeLessThanOrEqual(32);
  });

  it("stays silent on irregular, non-periodic spikes", () => {
    const spikeSeconds = [5, 23, 61, 68, 140, 205];
    const totalSamples = 250;
    const rtts = Array.from({ length: totalSamples }, (_, i) => (spikeSeconds.includes(i) ? 999 : 10));
    const a = mkSession({
      startedUtcMs: 0,
      endedUtcMs: totalSamples * 1000,
      targets: [mkTarget("per2")],
      samples: seriesFromRtts("per2", 0, 1000, rtts),
    });

    const results = analyzeComparison({ a, b: emptySession() });
    expect(results.find((f) => f.id === "periodicity:A:per2")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 7. burstiness
// ---------------------------------------------------------------------------

describe("burstiness", () => {
  function sessionWithSpikesAt(address: string, spikeSeconds: number[], totalSamples: number): Session {
    const rtts = Array.from({ length: totalSamples }, (_, i) => (spikeSeconds.includes(i) ? 999 : 10));
    return mkSession({
      startedUtcMs: 0,
      endedUtcMs: totalSamples * 1000,
      targets: [mkTarget(address)],
      samples: seriesFromRtts(address, 0, 1000, rtts),
    });
  }

  it("detects planted bursts (high coefficient of variation)", () => {
    const a = sessionWithSpikesAt("bu1", [10, 12, 14, 114, 116, 118], 130);
    const results = analyzeComparison({ a, b: emptySession() });
    const finding = results.find((f) => f.id === "burstiness:A:bu1");
    expect(finding?.severity).toBe("notable");
    expect(finding?.title).toContain("bursts");
    expect(Number(finding?.metrics.coefficientOfVariation)).toBeGreaterThanOrEqual(1.5);
  });

  it("detects strikingly regular spikes (low coefficient of variation)", () => {
    const spikeSeconds = Array.from({ length: 7 }, (_, i) => (i + 1) * 30); // 30..210
    const a = sessionWithSpikesAt("bu2", spikeSeconds, 220);
    const results = analyzeComparison({ a, b: emptySession() });
    const finding = results.find((f) => f.id === "burstiness:A:bu2");
    expect(finding?.severity).toBe("notable");
    expect(finding?.title).toContain("regular");
    expect(Number(finding?.metrics.coefficientOfVariation)).toBeLessThanOrEqual(0.4);
  });

  it("emits no finding for moderately variable intervals", () => {
    const a = sessionWithSpikesAt("bu3", [10, 20, 45, 50, 90, 105], 120);
    const results = analyzeComparison({ a, b: emptySession() });
    expect(results.find((f) => f.id === "burstiness:A:bu3")).toBeUndefined();
  });

  it("emits no finding for fewer than 6 spikes", () => {
    const a = sessionWithSpikesAt("bu4", [10, 12, 14, 114], 130);
    const results = analyzeComparison({ a, b: emptySession() });
    expect(results.find((f) => f.id === "burstiness:A:bu4")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 8. providerContribution
// ---------------------------------------------------------------------------

describe("providerContribution", () => {
  function sessionWithGateway(gatewayRtt: number, internetRtt: number): Session {
    return mkSession({
      startedUtcMs: 0,
      endedUtcMs: 60_000,
      targets: [mkTarget("gw", "gateway"), mkTarget("net", "internet")],
      samples: [
        ...seriesFromRtts("gw", 0, 1000, Array.from({ length: 60 }, () => gatewayRtt)),
        ...seriesFromRtts("net", 0, 1000, Array.from({ length: 60 }, () => internetRtt)),
      ],
    });
  }

  it("flags the upstream when the gateway is clean but internet targets are much slower", () => {
    const a = sessionWithGateway(10, 90); // gateway p95 10 <=20, delta 80 >=50
    const results = analyzeComparison({ a, b: emptySession() });
    const finding = results.find((f) => f.id === "provider-contribution:A");
    expect(finding?.severity).toBe("warning");
    expect(finding?.title).toContain("upstream adds");
  });

  it("flags the local link when the gateway itself is slow", () => {
    const a = sessionWithGateway(60, 70); // gateway p95 60 >= 50
    const results = analyzeComparison({ a, b: emptySession() });
    const finding = results.find((f) => f.id === "provider-contribution:A");
    expect(finding?.severity).toBe("warning");
    expect(finding?.title).toContain("local link dominates");
  });

  it("emits no finding when neither branch applies", () => {
    const a = sessionWithGateway(30, 40); // gateway p95 30: >20 so no upstream branch, <50 so no local-link branch
    const results = analyzeComparison({ a, b: emptySession() });
    expect(results.find((f) => f.id === "provider-contribution:A")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 9. targetAsymmetry
// ---------------------------------------------------------------------------

describe("targetAsymmetry", () => {
  function sessionWithTwoInternetTargets(rttA: number, rttB: number): Session {
    return mkSession({
      startedUtcMs: 0,
      endedUtcMs: 60_000,
      targets: [mkTarget("t1", "internet"), mkTarget("t2", "internet")],
      samples: [
        ...seriesFromRtts("t1", 0, 1000, Array.from({ length: 60 }, () => rttA)),
        ...seriesFromRtts("t2", 0, 1000, Array.from({ length: 60 }, () => rttB)),
      ],
    });
  }

  it("flags routing asymmetry when one target is much worse than the other", () => {
    const a = sessionWithTwoInternetTargets(20, 55); // ratio 2.75, diff 35
    const results = analyzeComparison({ a, b: emptySession() });
    const finding = results.find((f) => f.id === "target-asymmetry:A");
    expect(finding?.severity).toBe("notable");
    expect(finding?.metrics.worstAddress).toBe("t2");
    expect(finding?.metrics.bestAddress).toBe("t1");
  });

  it("emits no finding when the difference is too small", () => {
    const a = sessionWithTwoInternetTargets(20, 30); // ratio 1.5, diff 10
    const results = analyzeComparison({ a, b: emptySession() });
    expect(results.find((f) => f.id === "target-asymmetry:A")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 10. crossSessionComparison
// ---------------------------------------------------------------------------

describe("crossSessionComparison", () => {
  function sessionWith(address: string, rtt: number, lossIndices: number[] = []): Session {
    const rtts = Array.from({ length: 100 }, (_, i) => (lossIndices.includes(i) ? null : rtt));
    return mkSession({
      startedUtcMs: 0,
      endedUtcMs: 100_000,
      targets: [mkTarget(address)],
      samples: seriesFromRtts(address, 0, 1000, rtts),
    });
  }

  it("names the worse session when p95 differs substantially", () => {
    const a = sessionWith("shared1", 20);
    const b = sessionWith("shared1", 55);
    const results = analyzeComparison({ a, b });
    const finding = results.find((f) => f.id === "cross-session:shared1");
    expect(finding?.severity).toBe("warning");
    expect(finding?.title).toContain("Session B");
  });

  it("names the worse session when loss differs by 2pp or more, even with similar p95", () => {
    const a = sessionWith("shared2", 20, []);
    const b = sessionWith("shared2", 20, [10, 20, 30]); // 3% loss
    const results = analyzeComparison({ a, b });
    const finding = results.find((f) => f.id === "cross-session:shared2");
    expect(finding?.severity).toBe("warning");
    expect(finding?.title).toContain("Session B");
    expect(finding?.title.toLowerCase()).toContain("loss");
  });

  it("reports comparable when both sessions are similar", () => {
    const a = sessionWith("shared3", 20);
    const b = sessionWith("shared3", 22);
    const results = analyzeComparison({ a, b });
    const finding = results.find((f) => f.id === "cross-session:shared3");
    expect(finding?.severity).toBe("info");
    expect(finding?.title).toContain("comparable");
  });
});

// ---------------------------------------------------------------------------
// 11. simultaneousSpikes
// ---------------------------------------------------------------------------

describe("simultaneousSpikes", () => {
  function sessionWithSpikesAt(address: string, startedUtcMs: number, spikeSeconds: number[], totalSamples: number): Session {
    const rtts = Array.from({ length: totalSamples }, (_, i) => (spikeSeconds.includes(i) ? 999 : 10));
    return mkSession({
      startedUtcMs,
      endedUtcMs: startedUtcMs + totalSamples * 1000,
      targets: [mkTarget(address)],
      samples: seriesFromRtts(address, startedUtcMs, 1000, rtts),
    });
  }

  it("flags synchronized spikes across overlapping sessions as critical", () => {
    const spikeSeconds = [10, 30, 50, 70, 90];
    const a = sessionWithSpikesAt("sim1", 0, spikeSeconds, 120);
    const b = sessionWithSpikesAt("sim1", 0, spikeSeconds, 120);
    const results = analyzeComparison({ a, b });
    const finding = results.find((f) => f.id === "simultaneous-spikes:sim1");
    expect(finding?.severity).toBe("critical");
    expect(finding?.metrics.coOccurrence).toBe(1);
  });

  it("marks non-coincident spikes on an overlapping window as independent", () => {
    const a = sessionWithSpikesAt("sim2", 0, [10, 30, 50], 120);
    const b = sessionWithSpikesAt("sim2", 0, [15, 35, 55], 120);
    const results = analyzeComparison({ a, b });
    const finding = results.find((f) => f.id === "simultaneous-spikes:sim2");
    expect(finding?.severity).toBe("notable");
    expect(finding?.title).toContain("independent");
  });

  it("emits no finding when the sessions do not overlap in absolute time", () => {
    const spikeSeconds = [10, 30, 50];
    const a = sessionWithSpikesAt("sim3", 0, spikeSeconds, 60); // [0, 60s)
    const b = sessionWithSpikesAt("sim3", 500_000, spikeSeconds, 60); // starts long after a ends
    const results = analyzeComparison({ a, b });
    expect(results.find((f) => f.id === "simultaneous-spikes:sim3")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Cap at 24 and severity sort
// ---------------------------------------------------------------------------

describe("cap and sort", () => {
  // Both target flavors share the session's 600s (10 min) duration, so rates
  // must be computed against that shared duration rather than a per-target one.
  function criticalTarget(address: string): { target: Target; samples: Sample[] } {
    // 10 isolated 2-sample loss runs -> 10 spike events / 10 min = 1.0/min (critical)
    // and 20/600 = 3.33% loss (critical).
    const runStarts = [10, 65, 120, 175, 230, 285, 340, 395, 450, 505];
    const badIndices = new Set(runStarts.flatMap((i) => [i, i + 1]));
    const rtts = Array.from({ length: 600 }, (_, i) => (badIndices.has(i) ? null : 10));
    return { target: mkTarget(address), samples: seriesFromRtts(address, 0, 1000, rtts) };
  }

  function warningTarget(address: string): { target: Target; samples: Sample[] } {
    // 3 isolated 2-sample loss runs -> 3 spike events / 10 min = 0.3/min (warning)
    // and 6/600 = 1.0% loss (warning).
    const badIndices = new Set([100, 101, 300, 301, 500, 501]);
    const rtts = Array.from({ length: 600 }, (_, i) => (badIndices.has(i) ? null : 10));
    return { target: mkTarget(address), samples: seriesFromRtts(address, 0, 1000, rtts) };
  }

  function buildSession(prefix: string): Session {
    const criticals = Array.from({ length: 6 }, (_, i) => criticalTarget(`${prefix}-crit-${i}`));
    const warnings = Array.from({ length: 6 }, (_, i) => warningTarget(`${prefix}-warn-${i}`));
    const all = [...criticals, ...warnings];
    return mkSession({
      startedUtcMs: 0,
      endedUtcMs: 600_000,
      targets: all.map((x) => x.target),
      samples: all.flatMap((x) => x.samples),
    });
  }

  it("caps output at 24 findings, keeping the most severe ones", () => {
    const a = buildSession("a");
    const b = buildSession("b");
    const results = analyzeComparison({ a, b });
    expect(results.length).toBe(24);
    expect(results.every((f) => f.severity === "critical")).toBe(true);
  });

  it("sorts findings from critical to info", () => {
    const rtts = (lossIdx: number[]) => Array.from({ length: 1000 }, (_, i) => (lossIdx.includes(i) ? null : 10));
    const targets = [
      { address: "sort-crit", loss: [0, 50, 100, 150, 200, 250, 300, 350, 400, 450, 500, 550, 600, 650, 700, 750, 800, 850, 900, 950] }, // 2%
      { address: "sort-warn", loss: Array.from({ length: 10 }, (_, i) => i * 90) }, // 1%
      { address: "sort-notable", loss: [1, 2, 3] }, // 0.3%
      { address: "sort-info", loss: [1] }, // 0.1%
    ];
    const a = mkSession({
      startedUtcMs: 0,
      endedUtcMs: 1_000_000,
      targets: targets.map((t) => mkTarget(t.address)),
      samples: targets.flatMap((t) => seriesFromRtts(t.address, 0, 1000, rtts(t.loss))),
    });

    const results = analyzeComparison({ a, b: emptySession() });
    const order: Record<string, number> = { critical: 0, warning: 1, notable: 2, info: 3 };
    for (let i = 1; i < results.length; i += 1) {
      expect(order[results[i - 1].severity]).toBeLessThanOrEqual(order[results[i].severity]);
    }

    const lossFindings = results.filter((f) => f.id.startsWith("packet-loss:A:sort-"));
    const indexOf = (addr: string) => results.findIndex((f) => f.id === `packet-loss:A:${addr}`);
    expect(lossFindings.length).toBe(4);
    expect(indexOf("sort-crit")).toBeLessThan(indexOf("sort-warn"));
    expect(indexOf("sort-warn")).toBeLessThan(indexOf("sort-notable"));
    expect(indexOf("sort-notable")).toBeLessThan(indexOf("sort-info"));
  });
});

// ---------------------------------------------------------------------------
// Zero-duration guard
// ---------------------------------------------------------------------------

describe("zero-duration guard", () => {
  it("does not throw and skips rate-based findings when session duration is zero", () => {
    const a = mkSession({
      startedUtcMs: 1000,
      endedUtcMs: 1000,
      targets: [mkTarget("zd1")],
      samples: [
        { targetId: "zd1", seq: 0, tUtcMs: 1000, rttMs: 999 },
        { targetId: "zd1", seq: 1, tUtcMs: 1500, rttMs: null },
      ],
    });

    expect(() => analyzeComparison({ a, b: emptySession() })).not.toThrow();
    const results = analyzeComparison({ a, b: emptySession() });
    expect(results.find((f) => f.id.startsWith("spike-rate:A:"))).toBeUndefined();
    expect(results.find((f) => f.id.startsWith("periodicity:A:"))).toBeUndefined();
  });
});
