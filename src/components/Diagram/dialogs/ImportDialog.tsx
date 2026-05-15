import { AlertTriangle, FileCode2, FileJson, FolderOpen, Loader2 } from "lucide-react";
import { useState } from "react";
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
  const [busy, setBusy] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [previewDoc, setPreviewDoc] = useState<DiagramDoc | null>(null);

  function reset() {
    setPath(null);
    setWarnings([]);
    setError(null);
    setPreviewDoc(null);
  }

  async function pick() {
    const p = await ipc.pickOpenPathWithFilter("Diagram", ["json", "sql"]);
    if (!p) return;
    setPath(p);
    setWarnings([]);
    setError(null);
    setPreviewDoc(null);
    const fmt: Format = p.toLowerCase().endsWith(".sql") ? "sql" : "json";
    setFormat(fmt);
    await parseFile(p, fmt);
  }

  async function parseFile(p: string, fmt: Format) {
    setBusy(true);
    try {
      const text = await ipc.readTextFile(p);
      if (fmt === "json") {
        const result = parseJsonImport(text);
        setPreviewDoc(result.doc);
        setWarnings(result.warnings);
      } else {
        const result = await parseSqlImport(text, engine);
        setPreviewDoc(result.doc);
        setWarnings(result.warnings);
      }
    } catch (e) {
      setError(String(e));
      setPreviewDoc(null);
    } finally {
      setBusy(false);
    }
  }

  function doImport() {
    if (!previewDoc || !path) return;
    onImport(previewDoc, path);
    toast.success("Diagram imported");
    onOpenChange(false);
    reset();
  }

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
          auto-layout. SQL is best-effort and may skip statements it can't parse — see warnings
          below.
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
