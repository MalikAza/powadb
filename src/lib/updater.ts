import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import { toast } from "sonner";

type Options = {
  // When true, also surface "you're up to date" / errors to the user.
  // The background poller passes false; the manual settings button passes true.
  notifyWhenUpToDate?: boolean;
};

// Embedded at build time. Required because the GitHub repo is private — both
// the manifest (raw.githubusercontent.com) and the platform binaries
// (api.github.com release-asset URLs) need an Authorization header.
const ghToken = import.meta.env.VITE_UPDATER_GH_TOKEN;

const updateCheckOptions = ghToken
  ? {
      headers: {
        Authorization: `Bearer ${ghToken}`,
        Accept: "application/octet-stream",
      },
    }
  : undefined;

export async function runUpdateCheck({ notifyWhenUpToDate = false }: Options = {}) {
  let checking: string | number | undefined;
  if (notifyWhenUpToDate) {
    checking = toast.loading("Checking for updates…");
  }

  try {
    const update = await check(updateCheckOptions);
    if (checking !== undefined) toast.dismiss(checking);

    if (!update) {
      if (notifyWhenUpToDate) toast.success("You're on the latest version");
      return;
    }

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
