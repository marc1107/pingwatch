import { create } from "zustand";
import { persist } from "zustand/middleware";
import { getIpc, type AppDefaults, type ComparisonMeta, type OllamaStatus } from "../lib/ipc";
import type { Finding } from "../lib/findings";
import {
  buildLocalAiPrompt,
  parseLocalAiResult,
  RECOMMENDED_MODELS,
  RESPONSE_FORMAT_SCHEMA,
  type LocalAiResult,
} from "../lib/localAi";
import { SCHEMA_VERSION, type Sample, type Session, type Target } from "../lib/types";

export const INTERVAL_OPTIONS_MS = [250, 500, 1000, 2000, 5000] as const;
export const WINDOW_OPTIONS_MIN = [1, 5, 10, 30, 60] as const;
export const DEFAULT_INTERVAL_MS = 500;
export const DEFAULT_WINDOW_MIN = 10;
export const DEFAULT_TIMEOUT_MS = 1000;
export const DEFAULT_SPIKE_THRESHOLD_MS = 100;
const MAX_WINDOW_MIN = 60;

const DEFAULT_MODEL = "gemma4:e2b";

let unlisten: (() => void) | null = null;
let autoStopTimer: ReturnType<typeof setTimeout> | null = null;
let analysisRequestId: string | null = null;

function clearAutoStopTimer() {
  if (autoStopTimer !== null) {
    clearTimeout(autoStopTimer);
    autoStopTimer = null;
  }
}

/** (Re)schedules the auto-stop timer from the current remaining budget, or clears it if disabled/exhausted. */
function scheduleAutoStop(get: () => AppState) {
  clearAutoStopTimer();
  const { autoStopEnabled, windowMin, startedUtcMs, running } = get();
  if (!autoStopEnabled || !running || startedUtcMs === null) return;
  const remainingMs = windowMin * 60_000 - (Date.now() - startedUtcMs);
  if (remainingMs <= 0) return;
  autoStopTimer = setTimeout(() => {
    void get().stop();
  }, remainingMs);
}

export interface LocalAnalysisState {
  status: "idle" | "running" | "done" | "error";
  error: string | null;
  tokens: number;
  result: LocalAiResult | null;
  forKey: string | null;
}

interface AppState {
  defaults: AppDefaults | null;
  connectionLabel: string;
  intervalMs: number;
  timeoutMs: number;
  windowMin: number;
  spikeThresholdMs: number;
  autoUpdateEnabled: boolean;
  autoStopEnabled: boolean;
  targets: Target[];
  running: boolean;
  startedUtcMs: number | null;
  samplesByTarget: Record<string, Sample[]>;
  importedSessions: Session[];
  savedComparisons: ComparisonMeta[];
  view: "live" | "compare";
  error: string | null;
  ollama: OllamaStatus | null;
  selectedModel: string;
  analysis: LocalAnalysisState;

  init(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  clearData(): void;
  addTarget(label: string, address: string): Promise<void>;
  removeTarget(id: string): void;
  setIntervalMs(ms: number): void;
  setWindowMin(min: number): void;
  setSpikeThresholdMs(ms: number): void;
  setAutoUpdateEnabled(enabled: boolean): void;
  setAutoStopEnabled(enabled: boolean): void;
  setConnectionLabel(label: string): void;
  setView(view: "live" | "compare"): void;
  setError(error: string | null): void;
  buildSession(): Session | null;
  exportCurrent(): Promise<void>;
  importFile(): Promise<void>;
  removeImported(id: string): void;
  refreshSavedComparisons(): Promise<void>;
  saveCurrentComparison(name: string): Promise<void>;
  loadSavedComparison(id: string): Promise<void>;
  deleteSavedComparison(id: string): Promise<void>;
  refreshOllama(): Promise<void>;
  setSelectedModel(name: string): void;
  runLocalAnalysis(a: Session, b: Session, findings: Finding[]): Promise<void>;
  cancelLocalAnalysis(): Promise<void>;
}

function defaultTargets(gatewayIp: string | null): Target[] {
  const targets: Target[] = [];
  if (gatewayIp) {
    targets.push({ id: "gateway", label: "Router (gateway)", address: gatewayIp, kind: "gateway" });
  }
  targets.push(
    { id: "cloudflare", label: "Cloudflare DNS", address: "1.1.1.1", kind: "internet" },
    { id: "google", label: "Google DNS", address: "8.8.8.8", kind: "internet" },
  );
  return targets;
}

export const useStore = create<AppState>()(
  persist(
    (set, get) => ({
      defaults: null,
      connectionLabel: "",
      intervalMs: DEFAULT_INTERVAL_MS,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      windowMin: DEFAULT_WINDOW_MIN,
      spikeThresholdMs: DEFAULT_SPIKE_THRESHOLD_MS,
      autoUpdateEnabled: true,
      autoStopEnabled: true,
      targets: [],
      running: false,
      startedUtcMs: null,
      samplesByTarget: {},
      importedSessions: [],
      savedComparisons: [],
      view: "live",
      error: null,
      ollama: null,
      selectedModel: DEFAULT_MODEL,
      analysis: { status: "idle", error: null, tokens: 0, result: null, forKey: null },

      async init() {
        try {
          const ipc = await getIpc();
          const defaults = await ipc.getDefaults();
          set({ defaults, targets: defaultTargets(defaults.gatewayIp) });
        } catch (e) {
          set({ error: `failed to initialize: ${e}` });
        }
      },

      async start() {
        const { targets, intervalMs, timeoutMs, running } = get();
        if (running) return;
        try {
          const ipc = await getIpc();
          unlisten = await ipc.onPingBatch((batch) => {
            set((state) => {
              const cap = Math.ceil((MAX_WINDOW_MIN * 60_000) / state.intervalMs) + 64;
              const next = { ...state.samplesByTarget };
              for (const sample of batch) {
                const list = next[sample.targetId] ?? [];
                next[sample.targetId] =
                  list.length >= cap ? [...list.slice(list.length - cap + 1), sample] : [...list, sample];
              }
              return { samplesByTarget: next };
            });
          });
          await ipc.startMonitoring(targets, intervalMs, timeoutMs);
          set((state) => ({
            running: true,
            error: null,
            startedUtcMs: state.startedUtcMs ?? Date.now(),
          }));
          scheduleAutoStop(get);
        } catch (e) {
          unlisten?.();
          unlisten = null;
          set({ error: String(e) });
        }
      },

      async stop() {
        try {
          const ipc = await getIpc();
          await ipc.stopMonitoring();
        } finally {
          unlisten?.();
          unlisten = null;
          clearAutoStopTimer();
          set({ running: false });
        }
      },

      clearData() {
        set({ samplesByTarget: {}, startedUtcMs: null });
      },

      async addTarget(label, address) {
        const ipc = await getIpc();
        await ipc.validateTarget(address); // throws with a friendly message
        const id = `custom-${crypto.randomUUID().slice(0, 8)}`;
        set((state) => ({
          targets: [...state.targets, { id, label: label || address, address, kind: "custom" }],
        }));
        if (get().running) {
          await get().stop();
          await get().start();
        }
      },

      removeTarget(id) {
        set((state) => {
          const samplesByTarget = { ...state.samplesByTarget };
          delete samplesByTarget[id];
          return { targets: state.targets.filter((t) => t.id !== id), samplesByTarget };
        });
        const { running, stop, start } = get();
        if (running) {
          void stop().then(() => start());
        }
      },

      setIntervalMs(intervalMs) {
        set({ intervalMs });
        const { running, stop, start } = get();
        if (running) void stop().then(() => start());
      },
      setWindowMin(windowMin) {
        set({ windowMin });
        scheduleAutoStop(get);
      },
      setSpikeThresholdMs(spikeThresholdMs) {
        set({ spikeThresholdMs });
      },
      setAutoUpdateEnabled(autoUpdateEnabled) {
        set({ autoUpdateEnabled });
      },
      setAutoStopEnabled(autoStopEnabled) {
        set({ autoStopEnabled });
        scheduleAutoStop(get);
      },
      setConnectionLabel(connectionLabel) {
        set({ connectionLabel });
      },
      setView(view) {
        set({ view });
      },
      setError(error) {
        set({ error });
      },

      buildSession() {
        const { startedUtcMs, samplesByTarget, targets, intervalMs, timeoutMs, defaults, connectionLabel } =
          get();
        const samples = Object.values(samplesByTarget)
          .flat()
          .sort((a, b) => a.tUtcMs - b.tUtcMs);
        if (startedUtcMs === null || samples.length === 0) return null;
        return {
          schemaVersion: SCHEMA_VERSION,
          id: crypto.randomUUID(),
          startedUtcMs,
          endedUtcMs: samples[samples.length - 1].tUtcMs,
          intervalMs,
          timeoutMs,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          device: {
            hostname: defaults?.hostname ?? "unknown",
            os: defaults?.os ?? "unknown",
            connectionLabel: connectionLabel || "unlabeled",
          },
          targets,
          samples,
        };
      },

      async exportCurrent() {
        const session = get().buildSession();
        if (!session) {
          set({ error: "nothing recorded yet - start monitoring first" });
          return;
        }
        try {
          const ipc = await getIpc();
          const device = session.device.connectionLabel.replace(/[^a-zA-Z0-9-]+/g, "-");
          const stamp = new Date(session.startedUtcMs).toISOString().slice(0, 16).replace(/[T:]/g, "-");
          await ipc.exportSession(session, `pingwatch-session-${device}-${stamp}.json`);
        } catch (e) {
          set({ error: `export failed: ${e}` });
        }
      },

      async importFile() {
        try {
          const ipc = await getIpc();
          const session = await ipc.importSession();
          if (!session) return;
          set((state) => ({
            importedSessions: [...state.importedSessions.filter((s) => s.id !== session.id), session].slice(
              -2,
            ),
            view: "compare",
            error: null,
          }));
        } catch (e) {
          set({ error: `import failed: ${e}` });
        }
      },

      removeImported(id) {
        set((state) => ({
          importedSessions: state.importedSessions.filter((s) => s.id !== id),
        }));
      },

      async refreshSavedComparisons() {
        try {
          const ipc = await getIpc();
          const savedComparisons = await ipc.listComparisons();
          set({ savedComparisons });
        } catch (e) {
          set({ error: `failed to load saved comparisons: ${e}` });
        }
      },

      async saveCurrentComparison(name) {
        const { importedSessions } = get();
        if (importedSessions.length < 1) {
          set({ error: "import at least one session before saving a comparison" });
          return;
        }
        try {
          const ipc = await getIpc();
          await ipc.saveComparison(name, importedSessions);
          await get().refreshSavedComparisons();
        } catch (e) {
          set({ error: `failed to save comparison: ${e}` });
        }
      },

      async loadSavedComparison(id) {
        try {
          const ipc = await getIpc();
          const sessions = await ipc.loadComparison(id);
          set({ importedSessions: sessions, view: "compare", error: null });
        } catch (e) {
          set({ error: `failed to load comparison: ${e}` });
        }
      },

      async deleteSavedComparison(id) {
        try {
          const ipc = await getIpc();
          await ipc.deleteComparison(id);
          await get().refreshSavedComparisons();
        } catch (e) {
          set({ error: `failed to delete comparison: ${e}` });
        }
      },

      async refreshOllama() {
        try {
          const ipc = await getIpc();
          const ollama = await ipc.ollamaStatus();
          set({ ollama });
          // If the persisted selection isn't installed, fall back to an
          // installed model (preferring recommended ones) instead of
          // nudging the user to download something they don't need.
          const installed = ollama.models.map((m) => m.name);
          if (installed.length > 0 && !installed.includes(get().selectedModel)) {
            const recommendedFamilies = RECOMMENDED_MODELS.map((m) => m.name.split(":")[0]);
            const preferred = installed.find((name) =>
              recommendedFamilies.includes(name.split(":")[0]),
            );
            set({ selectedModel: preferred ?? installed[0] });
          }
        } catch {
          set({ ollama: { reachable: false, version: null, binaryInstalled: false, models: [] } });
        }
      },

      setSelectedModel(name) {
        set({ selectedModel: name });
      },

      async runLocalAnalysis(a, b, findings) {
        const key = `${a.id}|${b.id}`;
        const requestId = crypto.randomUUID();
        analysisRequestId = requestId;
        set({ analysis: { status: "running", error: null, tokens: 0, result: null, forKey: key } });
        try {
          const ipc = await getIpc();
          const prompt = buildLocalAiPrompt(a, b, findings);
          const text = await ipc.ollamaGenerate(
            requestId,
            get().selectedModel,
            prompt,
            RESPONSE_FORMAT_SCHEMA,
            (chunk) => {
              set((state) => ({
                analysis: { ...state.analysis, tokens: state.analysis.tokens + chunk.length / 4 },
              }));
            },
          );
          if (analysisRequestId !== requestId) return; // superseded by a newer request
          const result = parseLocalAiResult(text);
          set((state) => ({ analysis: { ...state.analysis, status: "done", result, forKey: key } }));
        } catch (e) {
          if (analysisRequestId !== requestId) return;
          const message = String(e instanceof Error ? e.message : e);
          if (message.toLowerCase().includes("cancelled")) {
            set((state) => ({ analysis: { ...state.analysis, status: "idle", error: null } }));
          } else {
            set((state) => ({ analysis: { ...state.analysis, status: "error", error: message } }));
          }
        }
      },

      async cancelLocalAnalysis() {
        try {
          if (analysisRequestId) {
            const ipc = await getIpc();
            await ipc.ollamaCancel(analysisRequestId);
          }
        } finally {
          set((state) => ({ analysis: { ...state.analysis, status: "idle" } }));
        }
      },
    }),
    {
      name: "pingwatch-settings",
      partialize: (state) => ({
        autoUpdateEnabled: state.autoUpdateEnabled,
        autoStopEnabled: state.autoStopEnabled,
        connectionLabel: state.connectionLabel,
        intervalMs: state.intervalMs,
        windowMin: state.windowMin,
        spikeThresholdMs: state.spikeThresholdMs,
        selectedModel: state.selectedModel,
      }),
    },
  ),
);

// Dev-only hook so browser-based UI tests can drive the store directly.
if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__pingwatchStore = useStore;
}
