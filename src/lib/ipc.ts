import type { Sample, Session, Target } from "./types";

export interface AppDefaults {
  gatewayIp: string | null;
  hostname: string;
  os: string;
}

export interface ComparisonMeta {
  id: string;
  name: string;
  savedUtcMs: number;
}

export interface OllamaModel {
  name: string;
  sizeBytes: number;
  parameterSize: string | null;
}

export interface OllamaStatus {
  reachable: boolean;
  version: string | null;
  binaryInstalled: boolean;
  models: OllamaModel[];
}

export interface OllamaPullProgress {
  model: string;
  status: string;
  completed: number | null;
  total: number | null;
}

export interface Ipc {
  getDefaults(): Promise<AppDefaults>;
  startMonitoring(targets: Target[], intervalMs: number, timeoutMs: number): Promise<void>;
  stopMonitoring(): Promise<void>;
  validateTarget(address: string): Promise<string>;
  onPingBatch(handler: (samples: Sample[]) => void): Promise<() => void>;
  /** Opens a save dialog and writes the session; resolves false if cancelled. */
  exportSession(session: Session, suggestedName: string): Promise<boolean>;
  /** Opens an open dialog and reads a session; resolves null if cancelled. */
  importSession(): Promise<Session | null>;
  saveComparison(name: string, sessions: Session[]): Promise<ComparisonMeta>;
  listComparisons(): Promise<ComparisonMeta[]>;
  loadComparison(id: string): Promise<Session[]>;
  deleteComparison(id: string): Promise<void>;
  ollamaStatus(): Promise<OllamaStatus>;
  ollamaPull(model: string, onProgress: (progress: OllamaPullProgress) => void): Promise<void>;
  ollamaGenerate(
    requestId: string,
    model: string,
    prompt: string,
    formatSchema: unknown,
    onChunk: (text: string) => void,
  ): Promise<string>;
  ollamaCancel(requestId: string): Promise<void>;
  openExternal(url: string): Promise<void>;
}

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function tauriIpc(): Promise<Ipc> {
  const { invoke } = await import("@tauri-apps/api/core");
  const { listen } = await import("@tauri-apps/api/event");
  const { open, save } = await import("@tauri-apps/plugin-dialog");
  const { SessionSchema } = await import("./types");

  return {
    getDefaults: () => invoke<AppDefaults>("get_defaults"),
    startMonitoring: (targets, intervalMs, timeoutMs) =>
      invoke("start_monitoring", { targets, intervalMs, timeoutMs }),
    stopMonitoring: () => invoke("stop_monitoring"),
    validateTarget: (address) => invoke<string>("validate_target", { address }),
    onPingBatch: async (handler) =>
      listen<Sample[]>("ping-batch", (event) => handler(event.payload)),
    exportSession: async (session, suggestedName) => {
      const path = await save({
        defaultPath: suggestedName,
        filters: [{ name: "PingWatch session", extensions: ["json"] }],
      });
      if (!path) return false;
      await invoke("export_session", { path, session });
      return true;
    },
    importSession: async () => {
      const path = await open({
        multiple: false,
        filters: [{ name: "PingWatch session", extensions: ["json"] }],
      });
      if (!path) return null;
      const raw = await invoke<unknown>("import_session", { path });
      return SessionSchema.parse(raw);
    },
    saveComparison: (name, sessions) =>
      invoke<ComparisonMeta>("save_comparison", { name, sessions }),
    listComparisons: () => invoke<ComparisonMeta[]>("list_comparisons"),
    loadComparison: async (id) => {
      const raw = await invoke<unknown[]>("load_comparison", { id });
      return SessionSchema.array().parse(raw);
    },
    deleteComparison: (id) => invoke("delete_comparison", { id }),
    ollamaStatus: () => invoke<OllamaStatus>("ollama_status"),
    ollamaPull: async (model, onProgress) => {
      const unlisten = await listen<OllamaPullProgress>("ollama-pull-progress", (event) => {
        if (event.payload.model === model) onProgress(event.payload);
      });
      try {
        await invoke("ollama_pull", { model });
      } finally {
        unlisten();
      }
    },
    ollamaGenerate: async (requestId, model, prompt, formatSchema, onChunk) => {
      const unlisten = await listen<{ requestId: string; content: string; done: boolean }>(
        "ollama-generate-chunk",
        (event) => {
          if (event.payload.requestId !== requestId) return;
          if (!event.payload.done) onChunk(event.payload.content);
        },
      );
      try {
        return await invoke<string>("ollama_generate", {
          requestId,
          model,
          prompt,
          formatSchema,
        });
      } finally {
        unlisten();
      }
    },
    ollamaCancel: (requestId) => invoke("ollama_cancel", { requestId }),
    openExternal: async (url) => {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(url);
    },
  };
}

export async function getIpc(): Promise<Ipc> {
  if (inTauri) return tauriIpc();
  const { mockIpc } = await import("./mockIpc");
  return mockIpc;
}
