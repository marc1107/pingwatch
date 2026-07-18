import { useEffect, useState } from "react";
import type { Update } from "@tauri-apps/plugin-updater";
import { useStore } from "../state/store";

type UpdateStage = "idle" | "downloading" | "ready";

export default function UpdateBanner() {
  const autoUpdateEnabled = useStore((s) => s.autoUpdateEnabled);
  const [update, setUpdate] = useState<Update | null>(null);
  const [stage, setStage] = useState<UpdateStage>("idle");
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window) || !autoUpdateEnabled) return;

    let cancelled = false;

    async function checkForUpdate() {
      try {
        const { check } = await import("@tauri-apps/plugin-updater");
        const found = await check();
        if (cancelled || !found) return;
        setUpdate(found);
        setStage("downloading");
        await found.downloadAndInstall();
        if (cancelled) return;
        setStage("ready");
      } catch (e) {
        console.warn("update check failed:", e);
      }
    }

    void checkForUpdate();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoUpdateEnabled]);

  if (!update || dismissed) return null;

  async function restartNow() {
    try {
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (e) {
      console.warn("relaunch failed:", e);
    }
  }

  return (
    <div className="card card-enter mb-3 flex items-center gap-3 border-line-2 px-4 py-2.5 text-sm">
      <span className="size-2 shrink-0 rounded-full bg-accent-bright" />
      <span className="text-ink">
        Update available: <span className="font-mono text-accent-bright">v{update.version}</span>
      </span>
      <span className="text-xs text-ink-3">
        {stage === "downloading" && "Downloading update…"}
        {stage === "ready" && "Update ready"}
      </span>
      <div className="ml-auto flex items-center gap-2">
        {stage === "ready" && (
          <button
            onClick={() => void restartNow()}
            className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-accent-bright"
          >
            Restart now
          </button>
        )}
        <button
          onClick={() => setDismissed(true)}
          className="rounded-lg border border-line-2 px-3 py-1.5 text-xs text-ink-2 transition-colors hover:border-accent hover:text-ink"
        >
          Later
        </button>
      </div>
    </div>
  );
}
