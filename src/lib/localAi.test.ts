import { describe, expect, it } from "vitest";
import { buildLocalAiPrompt, parseLocalAiResult } from "./localAi";
import type { Finding } from "./findings";
import type { Session, Target } from "./types";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function mkTarget(address: string, kind: Target["kind"] = "internet"): Target {
  return { id: address, label: address, address, kind };
}

function mkSession(opts: {
  startedUtcMs?: number;
  endedUtcMs?: number | null;
  connectionLabel?: string;
  targets?: Target[];
}): Session {
  return {
    schemaVersion: 1,
    id: `s-${opts.startedUtcMs ?? 0}`,
    startedUtcMs: opts.startedUtcMs ?? 0,
    endedUtcMs: opts.endedUtcMs === undefined ? null : opts.endedUtcMs,
    intervalMs: 1000,
    timeoutMs: 1000,
    timezone: "UTC",
    device: { hostname: "host", os: "macos", connectionLabel: opts.connectionLabel ?? "Wi-Fi" },
    targets: opts.targets ?? [mkTarget("1.1.1.1")],
    samples: [],
  };
}

function mkFinding(id: string): Finding {
  return {
    id,
    severity: "warning",
    scope: { session: "A" },
    title: `Title for ${id}`,
    metrics: { p95: 123 },
    detail: `Detail for ${id}`,
  };
}

const validResult = {
  summary: "A is better for gaming due to lower jitter.",
  confidence: "high" as const,
  explanations: [{ id: "finding-1", text: "Explanation text." }],
  recommendations: [{ priority: 1, text: "Do this first." }],
};

// ---------------------------------------------------------------------------
// parseLocalAiResult
// ---------------------------------------------------------------------------

describe("parseLocalAiResult", () => {
  it("accepts valid JSON", () => {
    const result = parseLocalAiResult(JSON.stringify(validResult));
    expect(result).toEqual(validResult);
  });

  it("accepts fenced ```json blocks", () => {
    const fenced = "```json\n" + JSON.stringify(validResult) + "\n```";
    const result = parseLocalAiResult(fenced);
    expect(result).toEqual(validResult);
  });

  it("accepts fenced blocks without a language tag", () => {
    const fenced = "```\n" + JSON.stringify(validResult) + "\n```";
    const result = parseLocalAiResult(fenced);
    expect(result).toEqual(validResult);
  });

  it("rejects garbage that is not JSON", () => {
    expect(() => parseLocalAiResult("not json at all")).toThrow();
  });

  it("rejects JSON that does not match the schema", () => {
    expect(() => parseLocalAiResult(JSON.stringify({ summary: "only a summary" }))).toThrow();
  });

  it("rejects an invalid confidence value", () => {
    const invalid = { ...validResult, confidence: "extreme" };
    expect(() => parseLocalAiResult(JSON.stringify(invalid))).toThrow();
  });
});

// ---------------------------------------------------------------------------
// buildLocalAiPrompt
// ---------------------------------------------------------------------------

describe("buildLocalAiPrompt", () => {
  it("contains both section markers", () => {
    const a = mkSession({ startedUtcMs: 0, endedUtcMs: 60_000 });
    const b = mkSession({ startedUtcMs: 0, endedUtcMs: 60_000 });
    const prompt = buildLocalAiPrompt(a, b, []);
    expect(prompt).toContain("=== SESSION CONTEXT ===");
    expect(prompt).toContain("=== FINDINGS (JSON) ===");
  });

  it("includes every finding id", () => {
    const a = mkSession({ startedUtcMs: 0, endedUtcMs: 60_000 });
    const b = mkSession({ startedUtcMs: 0, endedUtcMs: 60_000 });
    const findings = [mkFinding("spike-rate:A:1.1.1.1"), mkFinding("loss:B:8.8.8.8")];
    const prompt = buildLocalAiPrompt(a, b, findings);
    for (const f of findings) {
      expect(prompt).toContain(f.id);
    }
  });

  it("computes overlapsInTime true for overlapping sessions", () => {
    const a = mkSession({ startedUtcMs: 0, endedUtcMs: 60_000 });
    const b = mkSession({ startedUtcMs: 30_000, endedUtcMs: 90_000 });
    const prompt = buildLocalAiPrompt(a, b, []);
    const contextBlock = prompt.split("=== SESSION CONTEXT ===\n")[1].split("\n=== FINDINGS")[0];
    const context = JSON.parse(contextBlock);
    expect(context.overlapsInTime).toBe(true);
  });

  it("computes overlapsInTime false for disjoint sessions", () => {
    const a = mkSession({ startedUtcMs: 0, endedUtcMs: 60_000 });
    const b = mkSession({ startedUtcMs: 120_000, endedUtcMs: 180_000 });
    const prompt = buildLocalAiPrompt(a, b, []);
    const contextBlock = prompt.split("=== SESSION CONTEXT ===\n")[1].split("\n=== FINDINGS")[0];
    const context = JSON.parse(contextBlock);
    expect(context.overlapsInTime).toBe(false);
  });
});
