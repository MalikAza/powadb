import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ipcMock = {
  s3PrefixStats: vi.fn(),
  s3CancelJob: vi.fn(),
};

vi.mock("@/ipc", () => ({ ipc: ipcMock }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

const { statsKey, useS3Stats } = await import("@/stores/s3Stats");
const { S3PrefixStatsCell } = await import("./S3PrefixStatsCell");

const KEY = statsKey("c1", "bucket", "photos/");

function renderCell() {
  return render(<S3PrefixStatsCell connectionId="c1" bucket="bucket" prefix="photos/" />);
}

beforeEach(() => {
  vi.clearAllMocks();
  useS3Stats.setState({ entries: {} });
});

describe("S3PrefixStatsCell", () => {
  it("renders a calculate affordance when idle and starts a walk on click", () => {
    // Keep the walk pending so the entry stays in the running state.
    ipcMock.s3PrefixStats.mockReturnValue(new Promise(() => {}));
    renderCell();

    const button = screen.getByLabelText("Calculate objects and size");
    fireEvent.click(button);
    expect(ipcMock.s3PrefixStats).toHaveBeenCalledTimes(1);
    expect(useS3Stats.getState().entries[KEY]).toMatchObject({ state: "running" });
  });

  it("shows the live counter and a cancel button while running", () => {
    useS3Stats.setState({
      entries: { [KEY]: { state: "running", jobId: `s3stats-${KEY}`, objects: 10, bytes: 2048 } },
    });
    ipcMock.s3CancelJob.mockResolvedValue(true);
    renderCell();

    expect(screen.getByText(/10 obj/)).toBeDefined();
    fireEvent.click(screen.getByLabelText("Cancel stats calculation"));
    expect(ipcMock.s3CancelJob).toHaveBeenCalledWith(`s3stats-${KEY}`);
  });

  it("renders a retry affordance on error", () => {
    useS3Stats.setState({ entries: { [KEY]: { state: "error", message: "access denied" } } });
    renderCell();

    const retry = screen.getByText("failed");
    expect(retry.getAttribute("title")).toContain("access denied");
  });

  it("shows the cached totals and a recalculate button when done", () => {
    useS3Stats.setState({ entries: { [KEY]: { state: "done", objects: 42, bytes: 1024 } } });
    renderCell();

    expect(screen.getByText(/42 obj/)).toBeDefined();
    expect(screen.getByLabelText("Recalculate objects and size")).toBeDefined();
  });
});
