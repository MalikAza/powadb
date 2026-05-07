import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import { useEffect } from "react";
import { toast } from "sonner";

const CHECK_INTERVAL_MS = 30 * 60 * 1000;

export function UpdateChecker() {
  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      try {
        const update = await check();
        if (cancelled || !update) return;
        toast(`Update ${update.version} available`, {
          id: `update-${update.version}`,
          description: update.body || undefined,
          duration: Number.POSITIVE_INFINITY,
          action: {
            label: "Update",
            onClick: async () => {
              const installing = toast.loading("Downloading update…");
              try {
                await update.downloadAndInstall();
                toast.dismiss(installing);
                await relaunch();
              } catch (err) {
                toast.dismiss(installing);
                toast.error("Update failed", {
                  description: err instanceof Error ? err.message : String(err),
                });
              }
            },
          },
        });
      } catch (err) {
        console.warn("update check failed", err);
      }
    };

    run();
    const id = setInterval(run, CHECK_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return null;
}
