import { beforeEach, describe, expect, it, vi } from "vitest";
import type { S3PrefixStats, S3StatsProgressEvent } from "@/ipc";

const ipcMock = {
  s3PrefixStats: vi.fn(),
  s3CancelJob: vi.fn(),
};

vi.mock("@/ipc", () => ({
  ipc: ipcMock,
}));

// Captures the progress handler so tests can push events like the backend does.
let progressHandler: ((event: { payload: S3StatsProgressEvent }) => void) | null = null;
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((_name: string, handler: (event: { payload: S3StatsProgressEvent }) => void) => {
    progressHandler = handler;
    return Promise.resolve(() => {});
  }),
}));

const { statsKey, useS3Stats } = await import("./s3Stats");

const KEY = statsKey("c1", "bucket", "photos/");

function deferred() {
  let resolve!: (v: S3PrefixStats) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<S3PrefixStats>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  useS3Stats.setState({ entries: {} });
});

describe("statsKey", () => {
  it("composes connection, bucket and prefix", () => {
    expect(statsKey("c1", "b", "a/b/")).toBe("c1:b/a/b/");
    expect(statsKey("c1", "b", "")).toBe("c1:b/");
  });
});

describe("useS3Stats", () => {
  it("start sets a running entry then done with the totals", async () => {
    const d = deferred();
    ipcMock.s3PrefixStats.mockReturnValue(d.promise);

    const p = useS3Stats.getState().start("c1", "bucket", "photos/");
    expect(useS3Stats.getState().entries[KEY]).toMatchObject({
      state: "running",
      jobId: `s3stats-${KEY}`,
      objects: 0,
      bytes: 0,
    });

    d.resolve({ objects: 42, bytes: 1234, truncated: false });
    await p;
    expect(useS3Stats.getState().entries[KEY]).toEqual({
      state: "done",
      objects: 42,
      bytes: 1234,
    });
  });

  it("applies progress events to the matching running entry only", async () => {
    const d = deferred();
    ipcMock.s3PrefixStats.mockReturnValue(d.promise);

    const p = useS3Stats.getState().start("c1", "bucket", "photos/");
    progressHandler?.({ payload: { job_id: `s3stats-${KEY}`, objects: 10, bytes: 999 } });
    expect(useS3Stats.getState().entries[KEY]).toMatchObject({ objects: 10, bytes: 999 });

    // A stale/unknown job id is dropped.
    progressHandler?.({ payload: { job_id: "s3stats-other", objects: 77, bytes: 1 } });
    expect(useS3Stats.getState().entries[KEY]).toMatchObject({ objects: 10, bytes: 999 });

    d.resolve({ objects: 10, bytes: 999, truncated: false });
    await p;
  });

  it("does not start a second walk while one is running", async () => {
    const d = deferred();
    ipcMock.s3PrefixStats.mockReturnValue(d.promise);

    const p = useS3Stats.getState().start("c1", "bucket", "photos/");
    await useS3Stats.getState().start("c1", "bucket", "photos/");
    expect(ipcMock.s3PrefixStats).toHaveBeenCalledTimes(1);

    d.resolve({ objects: 0, bytes: 0, truncated: false });
    await p;
  });

  it("reverts to idle when the walk was canceled (truncated result)", async () => {
    const d = deferred();
    ipcMock.s3PrefixStats.mockReturnValue(d.promise);
    ipcMock.s3CancelJob.mockResolvedValue(true);

    const p = useS3Stats.getState().start("c1", "bucket", "photos/");
    await useS3Stats.getState().cancel("c1", "bucket", "photos/");
    expect(ipcMock.s3CancelJob).toHaveBeenCalledWith(`s3stats-${KEY}`);

    d.resolve({ objects: 5, bytes: 100, truncated: true });
    await p;
    expect(useS3Stats.getState().entries[KEY]).toBeUndefined();
  });

  it("stores an error entry when the walk fails", async () => {
    ipcMock.s3PrefixStats.mockRejectedValue("boom");
    await useS3Stats.getState().start("c1", "bucket", "photos/");
    expect(useS3Stats.getState().entries[KEY]).toEqual({ state: "error", message: "boom" });
  });

  it("cancel is a no-op when nothing is running", async () => {
    await useS3Stats.getState().cancel("c1", "bucket", "photos/");
    expect(ipcMock.s3CancelJob).not.toHaveBeenCalled();
  });
});
