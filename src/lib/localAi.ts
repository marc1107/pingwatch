import { z } from "zod";
import type { Finding } from "./findings";
import type { Session } from "./types";

export const RECOMMENDED_MODELS = [
  { name: "gemma4:e2b", note: "Recommended · fast · ~7 GB" },
  { name: "gemma4:e4b", note: "Better quality · ~10 GB" },
  { name: "gemma4:12b", note: "High quality · needs 16+ GB RAM" },
] as const;

export const RESPONSE_FORMAT_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    explanations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          text: { type: "string" },
        },
        required: ["id", "text"],
      },
    },
    recommendations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          priority: { type: "integer" },
          text: { type: "string" },
        },
        required: ["priority", "text"],
      },
    },
  },
  required: ["summary", "confidence", "explanations", "recommendations"],
};

export const LocalAiResultSchema = z.object({
  summary: z.string(),
  confidence: z.enum(["high", "medium", "low"]),
  explanations: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
    }),
  ),
  recommendations: z.array(
    z.object({
      priority: z.number().int(),
      text: z.string(),
    }),
  ),
});

export type LocalAiResult = z.infer<typeof LocalAiResultSchema>;

/**
 * Parses a model's raw text response into a validated LocalAiResult. Strips
 * an optional markdown code fence (```json ... ``` or ``` ... ```) before
 * parsing, since local models sometimes wrap JSON in one despite the format
 * constraint. Throws on invalid JSON or a schema mismatch.
 */
export function parseLocalAiResult(text: string): LocalAiResult {
  const fenced = text.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const jsonText = fenced ? fenced[1] : text.trim();
  const parsed: unknown = JSON.parse(jsonText);
  return LocalAiResultSchema.parse(parsed);
}

/** Session end time: explicit end, or the last sample's timestamp, or the start if there are no samples. */
function sessionEndMs(session: Session): number {
  return (
    session.endedUtcMs ??
    session.samples.reduce((max, sample) => Math.max(max, sample.tUtcMs), session.startedUtcMs)
  );
}

function overlapsInTime(a: Session, b: Session): boolean {
  return a.startedUtcMs <= sessionEndMs(b) && b.startedUtcMs <= sessionEndMs(a);
}

function sessionContext(session: Session) {
  return {
    label: session.device.connectionLabel,
    os: session.device.os,
    durationSec: Math.round((sessionEndMs(session) - session.startedUtcMs) / 1000),
    intervalMs: session.intervalMs,
    targets: session.targets.map((t) => ({ label: t.label, address: t.address, kind: t.kind })),
  };
}

const PROMPT_TEMPLATE = `You are a network diagnostics assistant inside the PingWatch app. Two latency monitoring sessions (A and B, usually two machines on the same home network) were compared. A deterministic analyzer has already computed verified findings from the raw data — every number below is correct and final; do not recompute, question, or invent numbers.

Respond ONLY with JSON matching the required schema.

1. "summary": 3-5 sentences: which connection is better for real-time gaming and why; where the problem most likely lives (that machine's link vs. router/local network vs. provider) judged from the findings as a whole; name the 1-2 most decisive findings.
2. "confidence": "high" | "medium" | "low" — lower it when the sessions do not overlap in time, are short, or findings point in conflicting directions.
3. "explanations": for EACH finding id in the input, 1-3 plain-language sentences: what this observation means, its most likely cause(s), and its practical impact on fast online games. Interpret the numbers, do not merely repeat them. Address every id exactly once.
4. "recommendations": up to 5 concrete actions ordered by expected impact (priority 1 = highest), each tied to what the findings actually show — no generic advice that ignores the data.

Guidance: latency to the router gateway isolates the local link; internet-target latency includes gateway plus provider. Simultaneous spikes on both machines point to a shared cause (router or provider). Periodic spikes often indicate scheduled interference such as background scans; clustered bursts suggest transient congestion. Jitter and packet loss hurt gaming more than a high but stable average. Write for a technically curious gamer; keep it clear, no jargon walls.`;

/**
 * Builds the full prompt sent to the local model: the verbatim instruction
 * template, followed by compact JSON blocks describing the session context
 * and the deterministic findings to explain.
 */
export function buildLocalAiPrompt(a: Session, b: Session, findings: Finding[]): string {
  const context = {
    a: sessionContext(a),
    b: sessionContext(b),
    overlapsInTime: overlapsInTime(a, b),
  };
  return `${PROMPT_TEMPLATE}\n=== SESSION CONTEXT ===\n${JSON.stringify(context)}\n=== FINDINGS (JSON) ===\n${JSON.stringify(findings)}`;
}
