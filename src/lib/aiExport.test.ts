import { describe, expect, it } from "vitest";
import { buildAiExport, downsampleSession } from "./aiExport";
import type { Sample, Session } from "./types";

const sample = (targetId: string, seq: number, tUtcMs: number, rttMs: number | null): Sample => ({
  targetId,
  seq,
  tUtcMs,
  rttMs,
});

function makeSession(opts: {
  startedUtcMs: number;
  durationMs: number;
  intervalMs: number;
  targetIds?: string[];
  label?: string;
  hostname?: string;
  rtt?: (targetId: string, i: number) => number | null;
}): Session {
  const {
    startedUtcMs,
    durationMs,
    intervalMs,
    targetIds = ["t1"],
    label = "Wi-Fi",
    hostname = "host",
    rtt = () => 20,
  } = opts;
  const samples: Sample[] = [];
  const count = Math.floor(durationMs / intervalMs);
  for (const targetId of targetIds) {
    for (let i = 0; i < count; i++) {
      samples.push(sample(targetId, i, startedUtcMs + i * intervalMs, rtt(targetId, i)));
    }
  }
  return {
    schemaVersion: 1,
    id: `s-${startedUtcMs}`,
    startedUtcMs,
    endedUtcMs: startedUtcMs + durationMs,
    intervalMs,
    timeoutMs: 1000,
    timezone: "UTC",
    device: { hostname, os: "macos", connectionLabel: label },
    targets: targetIds.map((id, i) => ({
      id,
      label: `Target ${i}`,
      address: `10.0.0.${i + 1}`,
      kind: i === 0 ? "gateway" : "internet",
    })),
    samples,
  };
}

describe("downsampleSession", () => {
  it("keeps bucket count within maxBucketsPerTarget", () => {
    const session = makeSession({ startedUtcMs: 0, durationMs: 600_000, intervalMs: 500 });
    const [tb] = downsampleSession(session, 240);
    expect(tb.buckets.length).toBeLessThanOrEqual(240);
  });

  it("chooses an adaptive bucketMs that is at least 1000ms", () => {
    const short = makeSession({ startedUtcMs: 0, durationMs: 5_000, intervalMs: 500 });
    const [tbShort] = downsampleSession(short, 240);
    expect(tbShort.bucketMs).toBe(1000);

    const long = makeSession({ startedUtcMs: 0, durationMs: 600_000, intervalMs: 500 });
    const [tbLong] = downsampleSession(long, 240);
    expect(tbLong.bucketMs).toBeGreaterThanOrEqual(1000);
    expect(tbLong.bucketMs).toBeGreaterThan(1000);
  });

  it("rounds avg and max to 1 decimal", () => {
    const session = makeSession({
      startedUtcMs: 0,
      durationMs: 2000,
      intervalMs: 500,
      rtt: (_id, i) => [10.123, 20.456, 10.123, 20.456][i],
    });
    const [tb] = downsampleSession(session, 240);
    expect(tb.buckets[0][1]).toBeCloseTo(15.3, 1); // avg of 10.123, 20.456
    expect(tb.buckets[0][2]).toBeCloseTo(20.5, 1); // max
  });

  it("emits a null avg and a set lossCount for an all-loss bucket", () => {
    const session = makeSession({
      startedUtcMs: 0,
      durationMs: 1000,
      intervalMs: 500,
      rtt: () => null,
    });
    const [tb] = downsampleSession(session, 240);
    expect(tb.buckets).toHaveLength(1);
    expect(tb.buckets[0][1]).toBeNull();
    expect(tb.buckets[0][2]).toBeNull();
    expect(tb.buckets[0][3]).toBe(2);
  });

  it("reports offsets as integer seconds since session start", () => {
    const startedUtcMs = 1_700_000_000_000;
    const session = makeSession({ startedUtcMs, durationMs: 3000, intervalMs: 500 });
    const [tb] = downsampleSession(session, 240);
    expect(tb.buckets[0][0]).toBe(0);
    expect(Number.isInteger(tb.buckets[0][0])).toBe(true);
  });
});

const MARKER_LINE = "=== DATA (JSON) ===";

/** The marker also appears inline in the analysis prompt's prose (quoted as
 * a literal), so we must locate the marker as a standalone line, not just
 * any substring occurrence, to find where the JSON payload starts. */
function extractJson(text: string): { format: string; sessions: unknown[] } {
  const match = text.match(/^=== DATA \(JSON\) ===$/m);
  if (!match || match.index === undefined) throw new Error("marker line not found");
  return JSON.parse(text.slice(match.index + match[0].length).trim());
}

describe("buildAiExport", () => {
  const a = makeSession({
    startedUtcMs: 0,
    durationMs: 60_000,
    intervalMs: 500,
    targetIds: ["gw", "inet1"],
    label: "Wi-Fi",
    hostname: "laptop-a",
    rtt: (id, i) => (i % 37 === 0 ? null : id === "gw" ? 5 : 20 + (i % 10)),
  });
  const b = makeSession({
    startedUtcMs: 0,
    durationMs: 60_000,
    intervalMs: 500,
    targetIds: ["gw", "inet1"],
    label: "Ethernet",
    hostname: "desktop-b",
    rtt: (id, i) => (i % 53 === 0 ? null : id === "gw" ? 3 : 15 + (i % 8)),
  });

  it("contains the DATA marker line exactly once and a parseable JSON payload", () => {
    const text = buildAiExport(a, b);
    const markerLines = text.split("\n").filter((line) => line === MARKER_LINE);
    expect(markerLines).toHaveLength(1);
    const parsed = extractJson(text);
    expect(parsed.format).toBe("pingwatch-ai-export/1");
    expect(parsed.sessions).toHaveLength(2);
  });

  it("includes both session labels", () => {
    const text = buildAiExport(a, b);
    const parsed = extractJson(text);
    const labels = (parsed.sessions as { label: string }[]).map((s) => s.label);
    expect(labels).toEqual(["Wi-Fi", "Ethernet"]);
  });

  it("caps spikes at 25 per target", () => {
    // Every other sample is a big spike -> far more than 25 spike events.
    const spiky = makeSession({
      startedUtcMs: 0,
      durationMs: 60_000,
      intervalMs: 500,
      targetIds: ["gw"],
      rtt: (_id, i) => (i % 2 === 0 ? 5 : 500),
    });
    const text = buildAiExport(spiky, b);
    const parsed = extractJson(text) as { sessions: { targets: { spikes: unknown[] }[] }[] };
    expect(parsed.sessions[0].targets[0].spikes.length).toBeLessThanOrEqual(25);
  });

  it("stays under 120000 characters for a ~10 minute two-session fixture at 500ms interval", () => {
    const tenMinA = makeSession({
      startedUtcMs: 0,
      durationMs: 600_000,
      intervalMs: 500,
      targetIds: ["gw", "inet1", "inet2"],
      label: "Wi-Fi",
      hostname: "laptop-a",
      rtt: (id, i) => (i % 41 === 0 ? null : id === "gw" ? 5 + (i % 4) : 20 + (i % 30)),
    });
    const tenMinB = makeSession({
      startedUtcMs: 0,
      durationMs: 600_000,
      intervalMs: 500,
      targetIds: ["gw", "inet1", "inet2"],
      label: "Ethernet",
      hostname: "desktop-b",
      rtt: (id, i) => (i % 59 === 0 ? null : id === "gw" ? 2 + (i % 3) : 15 + (i % 25)),
    });
    const text = buildAiExport(tenMinA, tenMinB);
    expect(text.length).toBeLessThan(120_000);
  });
});
