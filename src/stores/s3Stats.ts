import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { ipc, type S3StatsProgressEvent } from "@/ipc";

/// Session cache of on-demand S3 prefix stats (recursive object count + total
/// bytes), shared by the bucket tree and the object browser. Keyed by
/// `statsKey(connectionId, bucket, prefix)`; an absent key means "idle".
///
/// Deliberately never invalidated on mutations (upload/delete/rename leave
/// ancestor stats stale): a re-run is one click away and any invalidation
/// scheme would have to walk ancestor prefixes for little gain.

export type S3StatsEntry =
  | { state: "running"; jobId: string; objects: number; bytes: number }
  | { state: "done"; objects: number; bytes: number }
  | { state: "error"; message: string };

export function statsKey(connectionId: string, bucket: string, prefix: string): string {
  return `${connectionId}:${bucket}/${prefix}`;
}

type State = {
  entries: Record<string, S3StatsEntry>;
};

type Actions = {
  /** Start (or restart) a stats walk; no-op when one is already running. */
  start: (connectionId: string, bucket: string, prefix: string) => Promise<void>;
  /** Cancel a running walk; the pending `start` resolves and reverts to idle. */
  cancel: (connectionId: string, bucket: string, prefix: string) => Promise<void>;
};

/** Registered on first `start`; lives for the app's lifetime. */
let progressListenerStarted = false;

function ensureProgressListener() {
  if (progressListenerStarted) return;
  progressListenerStarted = true;
  void listen<S3StatsProgressEvent>("s3-stats-progress", (event) => {
    const { job_id, objects, bytes } = event.payload;
    const { entries } = useS3Stats.getState();
    // Match on the running entry's jobId so late events after completion or
    // cancellation are dropped instead of resurrecting a stale entry.
    for (const [key, entry] of Object.entries(entries)) {
      if (entry.state === "running" && entry.jobId === job_id) {
        useS3Stats.setState((s) => ({
          entries: { ...s.entries, [key]: { ...entry, objects, bytes } },
        }));
        return;
      }
    }
  });
}

export const useS3Stats = create<State & Actions>((set, get) => ({
  entries: {},

  start: async (connectionId, bucket, prefix) => {
    const key = statsKey(connectionId, bucket, prefix);
    if (get().entries[key]?.state === "running") return;
    ensureProgressListener();
    // Deterministic job id: duplicate clicks collapse onto the same job.
    const jobId = `s3stats-${key}`;
    set((s) => ({
      entries: { ...s.entries, [key]: { state: "running", jobId, objects: 0, bytes: 0 } },
    }));
    try {
      const stats = await ipc.s3PrefixStats(connectionId, bucket, prefix, jobId);
      if (stats.truncated) {
        // Canceled mid-scan: partial counts are not shown as totals.
        set((s) => {
          const { [key]: _, ...rest } = s.entries;
          return { entries: rest };
        });
      } else {
        set((s) => ({
          entries: {
            ...s.entries,
            [key]: { state: "done", objects: stats.objects, bytes: stats.bytes },
          },
        }));
      }
    } catch (e) {
      set((s) => ({ entries: { ...s.entries, [key]: { state: "error", message: String(e) } } }));
    }
  },

  cancel: async (connectionId, bucket, prefix) => {
    const entry = get().entries[statsKey(connectionId, bucket, prefix)];
    if (entry?.state !== "running") return;
    await ipc.s3CancelJob(entry.jobId);
  },
}));
