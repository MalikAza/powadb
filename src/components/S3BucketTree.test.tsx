import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ipcMock = {
  s3ListBuckets: vi.fn(),
  // Pulled in transitively by the S3PrefixStatsCell child's store.
  s3PrefixStats: vi.fn(),
  s3CancelJob: vi.fn(),
};

vi.mock("@/ipc", () => ({ ipc: ipcMock }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

const { useTabs } = await import("@/stores/tabs");
const { S3BucketTree } = await import("./S3BucketTree");

type ConnState = Parameters<typeof S3BucketTree>[0]["connState"];

function renderTree(connState: ConnState) {
  return render(<S3BucketTree connectionId="c1" connState={connState} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  useTabs.setState({ tabs: [], activeTabId: null });
});

describe("S3BucketTree", () => {
  it("does not list buckets until the connection is ready", () => {
    renderTree({ kind: "connecting" });
    expect(screen.getByText("Connecting…")).toBeDefined();
    expect(ipcMock.s3ListBuckets).not.toHaveBeenCalled();
  });

  it("surfaces a connection-level error", () => {
    renderTree({ kind: "error", message: "bad credentials" });
    expect(screen.getByText("bad credentials")).toBeDefined();
    expect(ipcMock.s3ListBuckets).not.toHaveBeenCalled();
  });

  it("lists buckets once ready and opens a tab when one is clicked", async () => {
    ipcMock.s3ListBuckets.mockResolvedValue([{ name: "photos" }, { name: "docs" }]);
    renderTree({ kind: "ready" });

    await waitFor(() => expect(screen.getByText("photos")).toBeDefined());
    expect(ipcMock.s3ListBuckets).toHaveBeenCalledWith("c1");
    expect(screen.getByText("docs")).toBeDefined();

    fireEvent.click(screen.getByText("photos"));
    const tab = useTabs.getState().tabs.find((t) => t.kind === "objects");
    if (tab?.kind !== "objects") throw new Error("expected an objects tab");
    expect(tab.bucket).toBe("photos");
    expect(tab.connectionId).toBe("c1");
  });

  it("shows an empty state when the account has no buckets", async () => {
    ipcMock.s3ListBuckets.mockResolvedValue([]);
    renderTree({ kind: "ready" });
    await waitFor(() => expect(screen.getByText("No buckets.")).toBeDefined());
  });

  it("renders the failure message when listing buckets rejects", async () => {
    ipcMock.s3ListBuckets.mockRejectedValue("network down");
    renderTree({ kind: "ready" });
    await waitFor(() => expect(screen.getByText(/network down/)).toBeDefined());
  });
});
