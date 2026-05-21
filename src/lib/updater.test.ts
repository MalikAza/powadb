import { beforeEach, describe, expect, it, vi } from "vitest";

const checkMock = vi.fn();
const relaunchMock = vi.fn();
const toastFn = vi.fn();
const toastSuccess = vi.fn();
const toastError = vi.fn();
const toastLoading = vi.fn();
const toastDismiss = vi.fn();

vi.mock("@tauri-apps/plugin-updater", () => ({
  check: (...args: unknown[]) => checkMock(...args),
}));

vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: (...args: unknown[]) => relaunchMock(...args),
}));

vi.mock("sonner", () => {
  const t = (...args: unknown[]) => toastFn(...args);
  t.success = (...args: unknown[]) => toastSuccess(...args);
  t.error = (...args: unknown[]) => toastError(...args);
  t.loading = (...args: unknown[]) => toastLoading(...args);
  t.dismiss = (...args: unknown[]) => toastDismiss(...args);
  return { toast: t };
});

const { runUpdateCheck } = await import("./updater");

beforeEach(() => {
  checkMock.mockReset();
  relaunchMock.mockReset();
  toastFn.mockReset();
  toastSuccess.mockReset();
  toastError.mockReset();
  toastLoading.mockReset();
  toastDismiss.mockReset();
});

describe("runUpdateCheck", () => {
  it("does nothing visible when up-to-date in silent mode", async () => {
    checkMock.mockResolvedValue(null);
    await runUpdateCheck();
    expect(toastLoading).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastFn).not.toHaveBeenCalled();
  });

  it("shows the 'latest version' toast when up-to-date in noisy mode", async () => {
    toastLoading.mockReturnValue("loader");
    checkMock.mockResolvedValue(null);
    await runUpdateCheck({ notifyWhenUpToDate: true });
    expect(toastLoading).toHaveBeenCalled();
    expect(toastDismiss).toHaveBeenCalledWith("loader");
    expect(toastSuccess).toHaveBeenCalledWith("You're on the latest version");
  });

  it("surfaces an update toast with action when one is available", async () => {
    const update = {
      version: "1.2.3",
      body: "release notes",
      downloadAndInstall: vi.fn().mockResolvedValue(undefined),
    };
    checkMock.mockResolvedValue(update);
    await runUpdateCheck();
    expect(toastFn).toHaveBeenCalledTimes(1);
    const [title, opts] = toastFn.mock.calls[0] as [
      string,
      {
        action: { onClick: () => void };
        cancel: { label: string; onClick: () => void };
      },
    ];
    expect(title).toContain("1.2.3");
    expect(opts).toMatchObject({
      id: "update-1.2.3",
      description: "A new version of PowaDB is ready to install.",
    });
    expect(opts.cancel.label).toBe("Later");
    opts.cancel.onClick();
    expect(toastDismiss).toHaveBeenCalledWith("update-1.2.3");

    toastLoading.mockReturnValue("dl");
    await opts.action.onClick();
    expect(update.downloadAndInstall).toHaveBeenCalled();
    expect(toastDismiss).toHaveBeenCalledWith("dl");
    expect(relaunchMock).toHaveBeenCalled();
  });

  it("reports update install errors via toast.error", async () => {
    const update = {
      version: "9.9.9",
      body: "",
      downloadAndInstall: vi.fn().mockRejectedValue(new Error("disk full")),
    };
    checkMock.mockResolvedValue(update);
    await runUpdateCheck();
    const [, opts] = toastFn.mock.calls[0] as [string, { action: { onClick: () => void } }];
    toastLoading.mockReturnValue("dl");
    await opts.action.onClick();
    expect(relaunchMock).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith("Update failed", { description: "disk full" });
  });

  it("warns silently when the check itself fails in silent mode", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    checkMock.mockRejectedValue(new Error("offline"));
    await runUpdateCheck();
    expect(toastError).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("surfaces the check failure when in noisy mode", async () => {
    toastLoading.mockReturnValue("loader");
    checkMock.mockRejectedValue(new Error("network down"));
    await runUpdateCheck({ notifyWhenUpToDate: true });
    expect(toastDismiss).toHaveBeenCalledWith("loader");
    expect(toastError).toHaveBeenCalledWith("Update check failed", { description: "network down" });
  });
});
