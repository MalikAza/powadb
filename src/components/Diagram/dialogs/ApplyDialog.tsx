import { sql } from "@codemirror/lang-sql";
import CodeMirror from "@uiw/react-codemirror";
import { AlertTriangle, Loader2, Play } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { type DiffOp, diffOpSummary, ipc } from "@/ipc";
import type { DbKind } from "@/types";
import type { DiagramDoc } from "../types";

function hasDestructive(ops: DiffOp[]): boolean {
  return ops.some(
    (o) =>
      o.kind === "drop_table" ||
      o.kind === "drop_column" ||
      o.kind === "drop_fk" ||
      o.kind === "alter_column_type",
  );
}

export function ApplyDialog({
  open,
  onOpenChange,
  connectionId,
  engine,
  doc,
  onApplied,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connectionId: string;
  engine: DbKind;
  doc: DiagramDoc;
  onApplied: () => void;
}) {
  const [ops, setOps] = useState<DiffOp[] | null>(null);
  const [script, setScript] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    if (!open) return;
    setOps(null);
    setScript("");
    setError(null);
    setLoading(true);
    (async () => {
      try {
        const diff = await ipc.diffDiagram(connectionId, JSON.stringify(doc));
        setOps(diff.ops);
        if (diff.ops.length === 0) {
          setScript("");
        } else {
          const sqlText = await ipc.generateAlterDdl(diff.ops, engine);
          setScript(sqlText);
        }
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [open, connectionId, engine, doc]);

  async function run() {
    if (!script.trim()) return;
    setRunning(true);
    try {
      await ipc.executeDdl(connectionId, script);
      toast.success("Applied to database");
      onApplied();
      onOpenChange(false);
    } catch (e) {
      toast.error(`Apply failed: ${String(e)}`);
      setError(String(e));
    } finally {
      setRunning(false);
    }
  }

  const empty = ops !== null && ops.length === 0;
  const destructive = ops !== null && hasDestructive(ops);

  return (
    <Dialog open={open} onOpenChange={(o) => !running && onOpenChange(o)}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Apply changes to database</DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center p-6 text-sm text-muted-foreground">
            <Loader2 className="mr-2 size-4 animate-spin" /> Computing diff…
          </div>
        ) : error ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        ) : empty ? (
          <p className="p-4 text-sm text-muted-foreground">
            No changes — the database already matches the diagram.
          </p>
        ) : (
          <>
            <div className="space-y-2">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Summary ({ops?.length} change{ops?.length === 1 ? "" : "s"})
              </p>
              <ul className="space-y-0.5 rounded-md border border-border p-2 font-mono text-[11px]">
                {ops?.map((op, i) => (
                  <li key={`${op.kind}-${i}`} className="truncate">
                    {diffOpSummary(op)}
                  </li>
                ))}
              </ul>
            </div>

            {destructive && (
              <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-300">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  This script drops tables, columns or constraints, or changes a column type. Make
                  sure you have a backup before applying.
                </span>
              </div>
            )}

            <div className="flex h-72 flex-col overflow-hidden rounded-md border border-border">
              <div className="min-h-0 flex-1 overflow-auto">
                <CodeMirror
                  value={script}
                  height="100%"
                  extensions={[sql()]}
                  editable={false}
                  basicSetup={{ lineNumbers: true, foldGutter: false }}
                  theme="dark"
                />
              </div>
            </div>
          </>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={running}>
            Close
          </Button>
          {!empty && (
            <Button
              variant={destructive ? "destructive" : "default"}
              onClick={run}
              disabled={loading || running || !script.trim()}
            >
              {running ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Play className="size-3.5" />
              )}
              {running ? "Applying…" : "Apply"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
