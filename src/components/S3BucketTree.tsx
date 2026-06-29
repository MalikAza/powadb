import { Database, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ipc, type S3Bucket } from "@/ipc";
import { cn } from "@/lib/utils";
import { useTabs } from "@/stores/tabs";

/** Mirrors the local ConnState shape used by SchemaTree. */
type ConnState = { kind: "idle" | "connecting" | "ready" } | { kind: "error"; message: string };

type Props = {
  connectionId: string;
  connState: ConnState;
};

/// Sidebar tree for S3 connections: a flat list of buckets. Clicking a bucket
/// opens an object-browser tab; deep navigation happens inside that pane, not
/// here, since buckets can hold millions of objects.
export function S3BucketTree({ connectionId, connState }: Props) {
  const openObjectBrowserTab = useTabs((s) => s.openObjectBrowserTab);
  const [buckets, setBuckets] = useState<S3Bucket[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setBuckets(await ipc.s3ListBuckets(connectionId));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [connectionId]);

  useEffect(() => {
    if (connState.kind === "ready") void refresh();
  }, [connState.kind, refresh]);

  return (
    <div className="text-xs">
      <div className="flex h-8 items-center justify-between px-2">
        <span className="font-medium text-muted-foreground">Buckets</span>
        <Button
          size="icon"
          variant="ghost"
          className="size-6"
          onClick={() => void refresh()}
          title="Refresh"
          aria-label="Refresh buckets"
        >
          <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
        </Button>
      </div>

      {connState.kind === "connecting" && (
        <div className="px-3 py-2 text-muted-foreground">Connecting…</div>
      )}
      {connState.kind === "error" && (
        <div className="px-3 py-2 text-destructive">{connState.message}</div>
      )}
      {error && <div className="px-3 py-2 text-destructive">{error}</div>}

      {buckets?.map((b) => (
        <button
          key={b.name}
          type="button"
          onClick={() => openObjectBrowserTab(connectionId, b.name)}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-sidebar-accent"
        >
          <Database className="size-3.5 text-primary" />
          <span className="truncate">{b.name}</span>
        </button>
      ))}

      {buckets?.length === 0 && !loading && (
        <div className="px-3 py-2 text-muted-foreground">No buckets.</div>
      )}
    </div>
  );
}
