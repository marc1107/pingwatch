// Browser-only stand-in for the Tauri backend so the full UI can be
// developed and tested without a native shell. Produces plausible latency
// traces: a quiet wired-like target, a noisy one with periodic spikes, and
// occasional packet loss.
import type { ComparisonMeta, Ipc, OllamaPullProgress, OllamaStatus } from "./ipc";
import type { Sample, Session, Target } from "./types";

const COMPARISONS_KEY = "pingwatch-comparisons";

interface StoredComparison {
  meta: ComparisonMeta;
  sessions: Session[];
}

function readComparisons(): StoredComparison[] {
  try {
    const raw = localStorage.getItem(COMPARISONS_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as StoredComparison[];
  } catch {
    return [];
  }
}

function writeComparisons(entries: StoredComparison[]) {
  localStorage.setItem(COMPARISONS_KEY, JSON.stringify(entries));
}

interface MockProfile {
  base: number;
  noise: number;
  spikeEvery: number; // average seconds between spikes
  spikeMs: number;
  lossPct: number;
}

const profiles = new Map<string, MockProfile>();

function profileFor(target: Target): MockProfile {
  const existing = profiles.get(target.id);
  if (existing) return existing;
  const profile: MockProfile =
    target.kind === "gateway"
      ? { base: 2.2, noise: 1.5, spikeEvery: 25, spikeMs: 90, lossPct: 0.2 }
      : target.address.startsWith("8.")
        ? { base: 18, noise: 7, spikeEvery: 12, spikeMs: 260, lossPct: 1.2 }
        : { base: 12, noise: 4, spikeEvery: 30, spikeMs: 140, lossPct: 0.4 };
  profiles.set(target.id, profile);
  return profile;
}

let timer: ReturnType<typeof setInterval> | null = null;
let seq = 0;
const listeners = new Set<(samples: Sample[]) => void>();

function gaussian(): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function sampleFor(target: Target, intervalMs: number): Sample {
  const p = profileFor(target);
  const lost = Math.random() * 100 < p.lossPct;
  let rtt: number | null = null;
  if (!lost) {
    rtt = Math.max(0.4, p.base + gaussian() * p.noise);
    const spikeChance = intervalMs / 1000 / p.spikeEvery;
    if (Math.random() < spikeChance) {
      rtt += p.spikeMs * (0.6 + Math.random());
    }
  }
  return { targetId: target.id, seq, tUtcMs: Date.now(), rttMs: rtt };
}

export const mockIpc: Ipc = {
  async getDefaults() {
    return { gatewayIp: "192.168.1.1", hostname: "dev-machine", os: "browser" };
  },

  async startMonitoring(targets, intervalMs) {
    if (timer) clearInterval(timer);
    timer = setInterval(() => {
      const samples = targets.map((t) => sampleFor(t, intervalMs));
      seq += 1;
      listeners.forEach((fn) => fn(samples));
    }, intervalMs);
  },

  async stopMonitoring() {
    if (timer) clearInterval(timer);
    timer = null;
  },

  async validateTarget(address) {
    if (!/^[a-zA-Z0-9.-]+$/.test(address)) throw new Error(`${address}: invalid address`);
    return address;
  },

  async onPingBatch(handler) {
    listeners.add(handler);
    return () => listeners.delete(handler);
  },

  async exportSession(session: Session, suggestedName: string) {
    const blob = new Blob([JSON.stringify(session, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = suggestedName;
    a.click();
    URL.revokeObjectURL(a.href);
    return true;
  },

  async importSession() {
    const { SessionSchema } = await import("./types");
    return new Promise((resolve, reject) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".json";
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return resolve(null);
        try {
          resolve(SessionSchema.parse(JSON.parse(await file.text())));
        } catch (e) {
          reject(new Error(`not a PingWatch session file: ${e}`));
        }
      };
      input.oncancel = () => resolve(null);
      input.click();
    });
  },

  async saveComparison(name, sessions) {
    const meta: ComparisonMeta = {
      id: crypto.randomUUID().slice(0, 8),
      name,
      savedUtcMs: Date.now(),
    };
    const entries = readComparisons();
    entries.push({ meta, sessions });
    writeComparisons(entries);
    return meta;
  },

  async listComparisons() {
    return readComparisons()
      .map((e) => e.meta)
      .sort((a, b) => b.savedUtcMs - a.savedUtcMs);
  },

  async loadComparison(id) {
    const entry = readComparisons().find((e) => e.meta.id === id);
    if (!entry) throw new Error(`no saved comparison with id ${id}`);
    return entry.sessions;
  },

  async deleteComparison(id) {
    writeComparisons(readComparisons().filter((e) => e.meta.id !== id));
  },

  async ollamaStatus(): Promise<OllamaStatus> {
    return {
      reachable: true,
      version: "0.5.4",
      binaryInstalled: true,
      models: [{ name: "gemma3:4b", sizeBytes: 3_300_000_000, parameterSize: "4.3B" }],
    };
  },

  async ollamaPull(model, onProgress) {
    const total = 3_300_000_000;
    const steps = [
      { status: "pulling manifest", completed: null, total: null },
      { status: "pulling", completed: Math.round(total * 0.3), total },
      { status: "pulling", completed: Math.round(total * 0.7), total },
      { status: "verifying digest", completed: total, total },
      { status: "success", completed: total, total },
    ];
    for (const step of steps) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      const progress: OllamaPullProgress = { model, ...step };
      onProgress(progress);
    }
  },

  async ollamaGenerate(_requestId, _model, prompt, _formatSchema, onChunk) {
    const ids = Array.from(prompt.matchAll(/"id":"([^"]+)"/g)).map((m) => m[1]);
    const explanationIds = ids.length > 0 ? ids : ["finding-1"];

    const chunks = [
      "Analyzing recent latency samples ",
      "across the monitored targets ",
      "to summarize what changed.",
    ];
    for (const chunk of chunks) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      onChunk(chunk);
    }

    const result = {
      summary: "Latency stayed within normal range with a brief spike on one target.",
      confidence: "medium",
      explanations: explanationIds.map((id) => ({
        id,
        text: `Finding ${id} looks consistent with typical network jitter rather than a persistent issue.`,
      })),
      recommendations: [
        { priority: 1, text: "Keep monitoring; no action needed unless the pattern repeats." },
      ],
    };
    return JSON.stringify(result);
  },

  async ollamaCancel(_requestId) {
    // no-op: the mock's simulated pull/generate loops are not cancellable.
  },

  async openExternal(url) {
    window.open(url, "_blank", "noopener,noreferrer");
  },
};
