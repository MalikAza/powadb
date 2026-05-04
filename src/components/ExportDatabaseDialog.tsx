import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Database, FileText, FolderOpen, Loader2, Wrench, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import {
  type DumpEngine,
  type DumpProgressEvent,
  type ExportSummary,
  ipc,
  type SchemaMeta,
  type TableRef,
  type ToolStatus,
} from "../ipc";
import { useConnections } from "../stores/connections";
import { useSchema } from "../stores/schema";
import { useUi } from "../stores/ui";

export function ExportDatabaseDialog() {
  const dialog = useUi((s) => s.exportDialog);
  const close = useUi((s) => s.closeExportDialog);
  const open = !!dialog;
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) close();
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        {dialog && <ExportDatabaseDialogBody connectionId={dialog.connectionId} onDone={close} />}
      </DialogContent>
    </Dialog>
  );
}

function ExportDatabaseDialogBody({
  connectionId,
  onDone,
}: {
  connectionId: string;
  onDone: () => void;
}) {
  const conn = useConnections((s) => s.connections.find((c) => c.id === connectionId));
  const schemas: SchemaMeta[] = useSchema((s) => s.byConnection[connectionId] ?? []);

  const [tools, setTools] = useState<ToolStatus | null>(null);
  const [engine, setEngine] = useState<DumpEngine>("tool");
  const [includeSchema, setIncludeSchema] = useState(true);
  const [includeData, setIncludeData] = useState(true);
  const [outputPath, setOutputPath] = useState<string>("");
  const [selectedTables, setSelectedTables] = useState<Record<string, boolean>>({});
  const [allTables, setAllTables] = useState(true);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<DumpProgressEvent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<ExportSummary | null>(null);
  const jobIdRef = useRef<string>("");

  useEffect(() => {
    if (!conn) return;
    ipc.checkDumpTools(conn.kind).then((status) => {
      setTools(status);
      if (!status.dump) setEngine("native");
    });
  }, [conn?.kind]);

  const tableEntries = useMemo(
    () => schemas.flatMap((s) => s.tables.map((t) => ({ schema: s.name, table: t.name }))),
    [schemas],
  );

  const tableKey = (s: string, t: string) => `${s}.${t}`;

  function toggleTable(s: string, t: string) {
    setAllTables(false);
    setSelectedTables((prev) => ({ ...prev, [tableKey(s, t)]: !prev[tableKey(s, t)] }));
  }

  function setAll(on: boolean) {
    if (on) {
      setAllTables(true);
      setSelectedTables({});
    } else {
      setAllTables(false);
      const next: Record<string, boolean> = {};
      for (const e of tableEntries) next[tableKey(e.schema, e.table)] = false;
      setSelectedTables(next);
    }
  }

  async function pickPath() {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const name = conn ? `${conn.database}-${today}.sql` : "dump.sql";
    const picked = await ipc.pickSavePath(name);
    if (picked) setOutputPath(picked);
  }

  async function run() {
    if (!conn || !outputPath) return;
    if (!includeSchema && !includeData) {
      setError("Select at least one of schema or data.");
      return;
    }

    let tablesToSend: TableRef[] | null = null;
    if (!allTables) {
      tablesToSend = tableEntries.filter((e) => selectedTables[tableKey(e.schema, e.table)]);
      if (tablesToSend.length === 0) {
        setError("Select at least one table, or use 'All tables'.");
        return;
      }
    }

    const jobId = crypto.randomUUID();
    jobIdRef.current = jobId;
    setRunning(true);
    setError(null);
    setSummary(null);
    setProgress(null);

    let unlisten: UnlistenFn | null = null;
    try {
      unlisten = await listen<DumpProgressEvent>("dump-progress", (e) => {
        if (e.payload.job_id === jobId) setProgress(e.payload);
      });
      const result = await ipc.exportDatabase(
        conn.id,
        {
          engine,
          include_schema: includeSchema,
          include_data: includeData,
          tables: tablesToSend,
          job_id: jobId,
        },
        outputPath,
      );
      setSummary(result);
    } catch (e) {
      setError(String(e));
    } finally {
      unlisten?.();
      setRunning(false);
    }
  }

  async function cancel() {
    if (!jobIdRef.current) return;
    await ipc.cancelDump(jobIdRef.current);
  }

  if (!conn) return null;

  const toolMissing = engine === "tool" && !tools?.dump;

  return (
    <>
      <DialogHeader>
        <DialogTitle>Export database — {conn.name}</DialogTitle>
      </DialogHeader>

      <div className="grid gap-4">
        <Section title="Engine">
          <div className="grid grid-cols-2 gap-2">
            <EngineCard
              icon={<Wrench className="size-4" />}
              label="Tool"
              hint={
                tools?.dump
                  ? `Uses ${conn.kind === "postgres" ? "pg_dump" : "mysqldump"}`
                  : "Not found on PATH — set its path in Settings"
              }
              selected={engine === "tool"}
              disabled={running}
              onSelect={() => setEngine("tool")}
            />
            <EngineCard
              icon={<Database className="size-4" />}
              label="Native"
              hint="Built-in. Basic schema + data only."
              selected={engine === "native"}
              disabled={running}
              onSelect={() => setEngine("native")}
            />
          </div>
        </Section>

        <Section title="Contents">
          <div className="flex gap-4">
            <label htmlFor="export-include-schema" className="flex items-center gap-2 text-sm">
              <Checkbox
                id="export-include-schema"
                checked={includeSchema}
                onCheckedChange={(v) => setIncludeSchema(Boolean(v))}
                disabled={running}
              />
              Schema (DDL)
            </label>
            <label htmlFor="export-include-data" className="flex items-center gap-2 text-sm">
              <Checkbox
                id="export-include-data"
                checked={includeData}
                onCheckedChange={(v) => setIncludeData(Boolean(v))}
                disabled={running}
              />
              Data (rows)
            </label>
          </div>
        </Section>

        <Section title="Tables">
          <label htmlFor="export-all-tables" className="flex items-center gap-2 text-sm">
            <Checkbox
              id="export-all-tables"
              checked={allTables}
              onCheckedChange={(v) => setAll(Boolean(v))}
              disabled={running}
            />
            All tables in this database
          </label>
          {!allTables && (
            <ScrollArea className="h-40 rounded-md border">
              <div className="grid gap-1 p-2">
                {tableEntries.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    No table metadata loaded — open the schema panel first.
                  </p>
                )}
                {tableEntries.map((e) => {
                  const k = tableKey(e.schema, e.table);
                  const id = `export-table-${k}`;
                  return (
                    <label key={k} htmlFor={id} className="flex items-center gap-2 text-xs">
                      <Checkbox
                        id={id}
                        checked={!!selectedTables[k]}
                        onCheckedChange={() => toggleTable(e.schema, e.table)}
                        disabled={running}
                      />
                      <span className="font-mono">{e.schema}.</span>
                      <span className="font-mono font-medium">{e.table}</span>
                    </label>
                  );
                })}
              </div>
            </ScrollArea>
          )}
        </Section>

        <Section title="Save to">
          <div className="flex gap-2">
            <Input
              value={outputPath}
              onChange={(e) => setOutputPath(e.target.value)}
              placeholder="No file selected"
              disabled={running}
              className="flex-1"
            />
            <Button type="button" variant="outline" onClick={pickPath} disabled={running}>
              <FolderOpen className="size-3.5" />
              Choose…
            </Button>
          </div>
        </Section>

        {progress && running && (
          <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            <div className="flex items-center gap-2">
              <Loader2 className="size-3 animate-spin" />
              <span>{progress.message ?? progress.phase}</span>
            </div>
            {progress.table && (
              <div className="mt-1 truncate font-mono">
                {progress.table}
                {progress.rows_done != null ? ` — ${progress.rows_done} rows` : ""}
              </div>
            )}
          </div>
        )}

        {error && (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        )}

        {summary && (
          <div className="rounded-md border border-primary/30 bg-primary/10 px-3 py-2 text-xs">
            <FileText className="mr-2 inline size-3.5" />
            Wrote {summary.bytes_written.toLocaleString()} bytes to{" "}
            <span className="font-mono">{outputPath}</span>.
          </div>
        )}
      </div>

      <DialogFooter>
        {running ? (
          <Button variant="destructive" onClick={cancel} type="button">
            <X className="size-3.5" />
            Cancel
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onDone} type="button">
              Close
            </Button>
            <Button
              onClick={run}
              type="button"
              disabled={!outputPath || toolMissing || (!includeSchema && !includeData)}
            >
              {summary ? "Run again" : "Export"}
            </Button>
          </>
        )}
      </DialogFooter>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-2">
      <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </h4>
      {children}
    </div>
  );
}

function EngineCard({
  icon,
  label,
  hint,
  selected,
  disabled,
  onSelect,
}: {
  icon: React.ReactNode;
  label: string;
  hint: string;
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      className={cn(
        "flex flex-col items-start gap-1 rounded-md border p-3 text-left transition-colors",
        selected ? "border-primary bg-primary/10" : "border-border hover:bg-accent",
        disabled && "opacity-50",
      )}
    >
      <div
        className={cn(
          "flex items-center gap-2 text-sm font-medium",
          selected ? "text-primary" : "text-foreground",
        )}
      >
        {icon}
        {label}
      </div>
      <p className="text-xs text-muted-foreground">{hint}</p>
    </button>
  );
}
