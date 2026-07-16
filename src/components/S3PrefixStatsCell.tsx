import { Loader2, RefreshCw, Sigma, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";
import { statsKey, useS3Stats } from "@/stores/s3Stats";

type Props = {
  connectionId: string;
  bucket: string;
  /** Folder prefix; an empty string means the whole bucket. */
  prefix: string;
  className?: string;
};

/// On-demand recursive stats (object count + total bytes) for a bucket or
/// folder row. Idle until clicked; then shows a live-incrementing counter with
/// a cancel affordance, and finally the cached totals with a hover re-run.
/// Rows navigate on click, so every button stops propagation.
export function S3PrefixStatsCell({ connectionId, bucket, prefix, className }: Props) {
  const entry = useS3Stats((s) => s.entries[statsKey(connectionId, bucket, prefix)]);
  const start = useS3Stats((s) => s.start);
  const cancel = useS3Stats((s) => s.cancel);

  if (!entry) {
    return (
      <Button
        size="icon"
        variant="ghost"
        className={cn("size-6 opacity-0 group-hover:opacity-100", className)}
        onClick={(e) => {
          e.stopPropagation();
          void start(connectionId, bucket, prefix);
        }}
        title="Calculate objects and size"
        aria-label="Calculate objects and size"
      >
        <Sigma className="size-3.5" />
      </Button>
    );
  }

  if (entry.state === "running") {
    return (
      <span className={cn("inline-flex items-center gap-1 text-muted-foreground", className)}>
        <Loader2 className="size-3 shrink-0 animate-spin" />
        <span className="truncate tabular-nums">
          {entry.objects.toLocaleString()} obj · {formatBytes(entry.bytes)}
        </span>
        <Button
          size="icon"
          variant="ghost"
          className="size-5 shrink-0"
          onClick={(e) => {
            e.stopPropagation();
            void cancel(connectionId, bucket, prefix);
          }}
          title="Cancel"
          aria-label="Cancel stats calculation"
        >
          <X className="size-3" />
        </Button>
      </span>
    );
  }

  if (entry.state === "error") {
    return (
      <button
        type="button"
        className={cn("text-destructive", className)}
        title={`${entry.message} — click to retry`}
        onClick={(e) => {
          e.stopPropagation();
          void start(connectionId, bucket, prefix);
        }}
      >
        failed
      </button>
    );
  }

  return (
    <span className={cn("inline-flex items-center gap-1 text-muted-foreground", className)}>
      <span className="truncate tabular-nums">
        {entry.objects.toLocaleString()} obj · {formatBytes(entry.bytes)}
      </span>
      <Button
        size="icon"
        variant="ghost"
        className="size-5 shrink-0 opacity-0 group-hover:opacity-100"
        onClick={(e) => {
          e.stopPropagation();
          void start(connectionId, bucket, prefix);
        }}
        title="Recalculate"
        aria-label="Recalculate objects and size"
      >
        <RefreshCw className="size-3" />
      </Button>
    </span>
  );
}
