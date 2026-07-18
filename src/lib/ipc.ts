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
  };
}

export async function getIpc(): Promise<Ipc> {
  if (inTauri) return tauriIpc();
  const { mockIpc } = await import("./mockIpc");
  return mockIpc;
}
