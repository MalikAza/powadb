import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import { toast } from "sonner";

type Options = {
  // When true, also surface "you're up to date" / errors to the user.
  // The background poller passes false; the manual settings button passes true.
  notifyWhenUpToDate?: boolean;
};

export async function runUpdateCheck({ notifyWhenUpToDate = false }: Options = {}) {
  let checking: string | number | undefined;
  if (notifyWhenUpToDate) {
    checking = toast.loading("Checking for updates…");
  }

  try {
    const update = await check();
    if (checking !== undefined) toast.dismiss(checking);

    if (!update) {
      if (notifyWhenUpToDate) toast.success("You're on the latest version");
      return;
    }

    const toastId = `update-${update.version}`;
    toast(`Update ${update.version} available`, {
      id: toastId,
      description: "A new version of PowaDB is ready to install.",
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
      cancel: {
        label: "Later",
        onClick: () => toast.dismiss(toastId),
      },
    });
  } catch (err) {
    if (checking !== undefined) toast.dismiss(checking);
    if (notifyWhenUpToDate) {
      toast.error("Update check failed", {
        description: err instanceof Error ? err.message : String(err),
      });
    } else {
      console.warn("update check failed", err);
    }
  }
}
