import { z } from "zod";

export const SCHEMA_VERSION = 1;

export const SampleSchema = z.object({
  targetId: z.string(),
  seq: z.number().int().nonnegative(),
  tUtcMs: z.number(),
  rttMs: z.number().nullable(),
});
export type Sample = z.infer<typeof SampleSchema>;

export const TargetKindSchema = z.enum(["gateway", "internet", "custom"]);
export type TargetKind = z.infer<typeof TargetKindSchema>;

export const TargetSchema = z.object({
  id: z.string(),
  label: z.string(),
  address: z.string(),
  kind: TargetKindSchema,
});
export type Target = z.infer<typeof TargetSchema>;

export const DeviceInfoSchema = z.object({
  hostname: z.string(),
  os: z.string(),
  connectionLabel: z.string(),
});
export type DeviceInfo = z.infer<typeof DeviceInfoSchema>;

export const SessionSchema = z.object({
  schemaVersion: z.number().int().positive(),
  id: z.string(),
  startedUtcMs: z.number(),
  endedUtcMs: z.number().nullable(),
  intervalMs: z.number().positive(),
  timeoutMs: z.number().positive(),
  timezone: z.string(),
  device: DeviceInfoSchema,
  targets: z.array(TargetSchema),
  samples: z.array(SampleSchema),
});
export type Session = z.infer<typeof SessionSchema>;

export interface TargetStats {
  count: number;
  lossCount: number;
  lossPct: number;
  min: number | null;
  avg: number | null;
  max: number | null;
  p95: number | null;
  p99: number | null;
  jitterMs: number | null;
  spikeCount: number;
  current: number | null;
}

export type Health = "good" | "warn" | "bad";

export interface SpikeEvent {
  startUtcMs: number;
  endUtcMs: number;
  peakRttMs: number | null; // null when the spike is pure packet loss
  sampleCount: number;
  hasLoss: boolean;
}

export interface AlignedPoint {
  tUtcMs: number;
  avgRttMs: number | null;
  lossPct: number;
}
