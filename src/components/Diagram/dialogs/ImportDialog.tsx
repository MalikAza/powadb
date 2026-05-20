import { AlertTriangle, FileCode2, FileJson, FolderOpen, Loader2 } from "lucide-react";
import { useReducer, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ipc } from "@/ipc";
import type { DbKind } from "@/types";
import { parseJsonImport, parseSqlImport } from "../importDiagram";
import type { DiagramDoc } from "../types";

type Format = "json" | "sql";

type LoadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; doc: DiagramDoc; warnings: string[] }
  | { status: "error"; error: string };

type LoadAction =
  | { type: "reset" }
  | { type: "start" }
  | { type: "success"; doc: DiagramDoc; warnings: string[] }
  | { type: "fail"; error: string };

function loadReducer(_s: LoadState, a: LoadAction): LoadState {
  switch (a.type) {
    case "reset":
      return { status: "idle" };
    case "start":
      return { status: "loading" };
    case "success":
      return { status: "ready", doc: a.doc, warnings: a.warnings };
    case "fail":
      return { status: "error", error: a.error };
  }
}

export function ImportDialog({
  open,
  onOpenChange,
  engine,
  onImport,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  engine: DbKind;
  onImport: (doc: DiagramDoc, sourcePath: string) => void;
}) {
  const [path, setPath] = useState<string | null>(null);
  const [format, setFormat] = useState<Format>("json");
  const [load, dispatch] = useReducer(loadReducer, { status: "idle" });

  function reset() {
    setPath(null);
    dispatch({ type: "reset" });
  }

  async function pick() {
    const p = await ipc.pickOpenPathWithFilter("Diagram", ["json", "sql"]);
    if (!p) return;
    setPath(p);
    dispatch({ type: "reset" });
    const fmt: Format = p.toLowerCase().endsWith(".sql") ? "sql" : "json";
    setFormat(fmt);
    await parseFile(p, fmt);
  }

  async function parseFile(p: string, fmt: Format) {
    dispatch({ type: "start" });
    try {
      const text = await ipc.readTextFile(p);
      const result = fmt === "json" ? parseJsonImport(text) : await parseSqlImport(text, engine);
      dispatch({ type: "success", doc: result.doc, warnings: result.warnings });
    } catch (e) {
      dispatch({ type: "fail", error: String(e) });
    }
  }

  function doImport() {
    if (load.status !== "ready" || !path) return;
    onImport(load.doc, path);
    toast.success("Diagram imported");
    onOpenChange(false);
    reset();
  }

  const busy = load.status === "loading";
  const previewDoc = load.status === "ready" ? load.doc : null;
  const warnings = load.status === "ready" ? load.warnings : [];
  const error = load.status === "error" ? load.error : null;
  const tableCount = previewDoc?.tables.length ?? 0;
  const edgeCount = previewDoc?.edges.length ?? 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import diagram</DialogTitle>
        </DialogHeader>

        <p className="text-xs text-muted-foreground">
          Importing replaces the current canvas. JSON imports preserve table positions; SQL imports
          auto-layout. SQL is best-effort and may skip statements it can't parse (see warnings
          below).
        </p>

        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" className="h-8 gap-1.5 text-xs" onClick={pick}>
            <FolderOpen className="size-3.5" /> Choose file…
          </Button>
          {path && (
            <span className="flex min-w-0 items-center gap-1.5 truncate text-[11px] text-muted-foreground">
              {format === "json" ? (
                <FileJson className="size-3.5 shrink-0" />
              ) : (
                <FileCode2 className="size-3.5 shrink-0" />
              )}
              <span className="truncate" title={path}>
                {path}
              </span>
            </span>
          )}
        </div>

        {busy ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Parsing…
          </div>
        ) : error ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        ) : previewDoc ? (
          <div className="space-y-2">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Preview
            </p>
            <div className="rounded-md border border-border p-2 text-xs">
              <span className="font-medium">{tableCount}</span> table{tableCount === 1 ? "" : "s"},{" "}
              <span className="font-medium">{edgeCount}</span> foreign key
              {edgeCount === 1 ? "" : "s"}
            </div>
            {warnings.length > 0 && (
              <div className="space-y-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-300">
                <div className="flex items-center gap-1.5 font-medium">
                  <AlertTriangle className="size-3.5" />
                  {warnings.length} warning{warnings.length === 1 ? "" : "s"}
                </div>
                <ul className="max-h-32 list-disc space-y-0.5 overflow-y-auto pl-5">
                  {warnings.map((w) => (
                    <li key={w} className="truncate" title={w}>
                      {w}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={doImport} disabled={!previewDoc || busy}>
            Import
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
