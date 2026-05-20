import { RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { type HistoryEntry, ipc } from "../ipc";
import { useConnections } from "../stores/connections";
import { useTabs } from "../stores/tabs";
import { ConfirmDialog } from "./ConfirmDialog";

export function HistoryPanel() {
  const activeId = useConnections((s) => s.activeId);
  const newQueryTab = useTabs((s) => s.newQueryTab);
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);

  const refresh = useCallback(async () => {
    if (!activeId) return;
    setLoading(true);
    try {
      setEntries(await ipc.listHistory(activeId, 200));
    } finally {
      setLoading(false);
    }
  }, [activeId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  function openInNewTab(sql: string) {
    if (!activeId) return;
    newQueryTab(activeId, sql);
  }

  return (
    <div className="text-xs">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          History
        </span>
        <div className="flex gap-1">
          <Button
            size="icon"
            variant="ghost"
            className="size-6"
            onClick={refresh}
            disabled={loading}
          >
            <RefreshCw className={loading ? "size-3 animate-spin" : "size-3"} />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="size-6"
            onClick={() => {
              if (!activeId) return;
              setConfirmClearOpen(true);
            }}
            disabled={!activeId || entries.length === 0}
            title="Clear history"
          >
            <Trash2 className="size-3" />
          </Button>
        </div>
      </div>
      {entries.length === 0 && (
        <p className="text-muted-foreground">No history yet: run a query.</p>
      )}
      <div className="flex flex-col gap-1">
        {entries.map((e) => {
          const oneLine = e.sql.replace(/\s+/g, " ").trim();
          return (
            <div
              key={e.id}
              onDoubleClick={() => openInNewTab(e.sql)}
              title="Double-click to open in a new query tab"
              className="cursor-pointer rounded border border-border/40 bg-card/50 p-2 hover:bg-sidebar-accent"
            >
              <div
                className={`truncate font-mono text-[11px] ${e.error ? "text-destructive" : ""}`}
              >
                {oneLine}
              </div>
              <div className="mt-1 flex flex-wrap gap-x-2 text-[10px] text-muted-foreground">
                <span>{e.executed_at}</span>
                {e.error ? (
                  <span>· {e.error}</span>
                ) : (
                  <>
                    {e.elapsed_ms != null && <span>· {e.elapsed_ms}ms</span>}
                    {e.row_count != null && <span>· {e.row_count} rows</span>}
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <ConfirmDialog
        open={confirmClearOpen}
        onOpenChange={setConfirmClearOpen}
        title="Clear query history?"
        description="All recorded queries for this connection will be permanently removed."
        confirmLabel="Clear"
        onConfirm={async () => {
          if (!activeId) return;
          setConfirmClearOpen(false);
          await ipc.clearHistory(activeId);
          await refresh();
        }}
      />
    </div>
  );
}
