import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Database, FileText, FolderOpen, Loader2, Wrench, X } from "lucide-react";
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
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
import type { DbKind } from "@/types";
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

  type Form = {
    engine: DumpEngine;
    includeSchema: boolean;
    includeData: boolean;
    outputPath: string;
    selectedTables: Record<string, boolean>;
    allTables: boolean;
  };
  const [tools, setTools] = useState<ToolStatus | null>(null);
  const [form, setForm] = useState<Form>({
    engine: "tool",
    includeSchema: true,
    includeData: true,
    outputPath: "",
    selectedTables: {},
    allTables: true,
  });
  type RunState = {
    status: "idle" | "running" | "done" | "error";
    progress: DumpProgressEvent | null;
    error: string | null;
    summary: ExportSummary | null;
  };
  type RunAction =
    | { type: "start" }
    | { type: "progress"; progress: DumpProgressEvent }
    | { type: "success"; summary: ExportSummary }
    | { type: "fail"; error: string }
    | { type: "setError"; error: string };
  const [run, dispatchRun] = useReducer(
    (s: RunState, a: RunAction): RunState => {
      switch (a.type) {
        case "start":
          return { status: "running", progress: null, error: null, summary: null };
        case "progress":
          return { ...s, progress: a.progress };
        case "success":
          return { status: "done", progress: s.progress, error: null, summary: a.summary };
        case "fail":
          return { status: "error", progress: s.progress, error: a.error, summary: null };
        case "setError":
          return { ...s, error: a.error };
      }
    },
    { status: "idle", progress: null, error: null, summary: null },
  );
  const running = run.status === "running";
  const progress = run.progress;
  const error = run.error;
  const summary = run.summary;
  const jobIdRef = useRef<string>("");

  const engine = form.engine;
  const includeSchema = form.includeSchema;
  const includeData = form.includeData;
  const outputPath = form.outputPath;
  const selectedTables = form.selectedTables;
  const allTables = form.allTables;
  const setEngine = (v: DumpEngine) => setForm((f) => ({ ...f, engine: v }));
  const setIncludeSchema = (v: boolean) => setForm((f) => ({ ...f, includeSchema: v }));
  const setIncludeData = (v: boolean) => setForm((f) => ({ ...f, includeData: v }));
  const setOutputPath = (v: string) => setForm((f) => ({ ...f, outputPath: v }));

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
    setForm((f) => ({
      ...f,
      allTables: false,
      selectedTables: {
        ...f.selectedTables,
        [tableKey(s, t)]: !f.selectedTables[tableKey(s, t)],
      },
    }));
  }

  function setAll(on: boolean) {
    if (on) {
      setForm((f) => ({ ...f, allTables: true, selectedTables: {} }));
    } else {
      const next: Record<string, boolean> = {};
      for (const e of tableEntries) next[tableKey(e.schema, e.table)] = false;
      setForm((f) => ({ ...f, allTables: false, selectedTables: next }));
    }
  }

  async function pickPath() {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const name = conn ? `${conn.database}-${today}.sql` : "dump.sql";
    const picked = await ipc.pickSavePath(name);
    if (picked) setOutputPath(picked);
  }

  async function runExport() {
    if (!conn || !outputPath) return;
    if (!includeSchema && !includeData) {
      dispatchRun({ type: "setError", error: "Select at least one of schema or data." });
      return;
    }

    let tablesToSend: TableRef[] | null = null;
    if (!allTables) {
      tablesToSend = tableEntries.filter((e) => selectedTables[tableKey(e.schema, e.table)]);
      if (tablesToSend.length === 0) {
        dispatchRun({
          type: "setError",
          error: "Select at least one table, or use 'All tables'.",
        });
        return;
      }
    }

    const jobId = crypto.randomUUID();
    jobIdRef.current = jobId;
    dispatchRun({ type: "start" });

    let unlisten: UnlistenFn | null = null;
    try {
      unlisten = await listen<DumpProgressEvent>("dump-progress", (e) => {
        if (e.payload.job_id === jobId) dispatchRun({ type: "progress", progress: e.payload });
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
      dispatchRun({ type: "success", summary: result });
    } catch (e) {
      dispatchRun({ type: "fail", error: String(e) });
    } finally {
      unlisten?.();
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
        <DialogTitle>Export database: {conn.name}</DialogTitle>
      </DialogHeader>

      <div className="grid gap-4">
        <EngineSection
          engine={engine}
          toolAvailable={!!tools?.dump}
          toolName={dumpToolName(conn.kind)}
          running={running}
          onSelect={setEngine}
        />

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

        <TableSelector
          allTables={allTables}
          tableEntries={tableEntries}
          selectedTables={selectedTables}
          running={running}
          onToggleAll={setAll}
          onToggleTable={toggleTable}
        />

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

        <ExportStatus
          running={running}
          progress={progress}
          error={error}
          summary={summary}
          outputPath={outputPath}
        />
      </div>

      <RunFooter
        running={running}
        canRun={!!outputPath && !toolMissing && (includeSchema || includeData)}
        hasSummary={!!summary}
        onClose={onDone}
        onRun={runExport}
        onCancel={cancel}
      />
    </>
  );
}

function dumpToolName(kind: DbKind): string {
  if (kind === "postgres") return "pg_dump";
  if (kind === "mysql") return "mysqldump";
  if (kind === "mongo") return "mongodump";
  return "sqlite3";
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

function EngineSection({
  engine,
  toolAvailable,
  toolName,
  running,
  onSelect,
}: {
  engine: DumpEngine;
  toolAvailable: boolean;
  toolName: string;
  running: boolean;
  onSelect: (v: DumpEngine) => void;
}) {
  return (
    <Section title="Engine">
      <div className="grid grid-cols-2 gap-2">
        <EngineCard
          icon={<Wrench className="size-4" />}
          label="Tool"
          hint={toolAvailable ? `Uses ${toolName}` : "Not found on PATH — set its path in Settings"}
          selected={engine === "tool"}
          disabled={running}
          onSelect={() => onSelect("tool")}
        />
        <EngineCard
          icon={<Database className="size-4" />}
          label="Native"
          hint="Built-in. Basic schema + data only."
          selected={engine === "native"}
          disabled={running}
          onSelect={() => onSelect("native")}
        />
      </div>
    </Section>
  );
}

function TableSelector({
  allTables,
  tableEntries,
  selectedTables,
  running,
  onToggleAll,
  onToggleTable,
}: {
  allTables: boolean;
  tableEntries: { schema: string; table: string }[];
  selectedTables: Record<string, boolean>;
  running: boolean;
  onToggleAll: (on: boolean) => void;
  onToggleTable: (schema: string, table: string) => void;
}) {
  return (
    <Section title="Tables">
      <label htmlFor="export-all-tables" className="flex items-center gap-2 text-sm">
        <Checkbox
          id="export-all-tables"
          checked={allTables}
          onCheckedChange={(v) => onToggleAll(Boolean(v))}
          disabled={running}
        />
        All tables in this database
      </label>
      {!allTables && (
        <ScrollArea className="h-40 rounded-md border">
          <div className="grid gap-1 p-2">
            {tableEntries.length === 0 && (
              <p className="text-xs text-muted-foreground">
                No table metadata loaded: open the schema panel first.
              </p>
            )}
            {tableEntries.map((e) => {
              const k = `${e.schema}.${e.table}`;
              const id = `export-table-${k}`;
              return (
                <label key={k} htmlFor={id} className="flex items-center gap-2 text-xs">
                  <Checkbox
                    id={id}
                    checked={!!selectedTables[k]}
                    onCheckedChange={() => onToggleTable(e.schema, e.table)}
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
  );
}

function ExportStatus({
  running,
  progress,
  error,
  summary,
  outputPath,
}: {
  running: boolean;
  progress: DumpProgressEvent | null;
  error: string | null;
  summary: ExportSummary | null;
  outputPath: string;
}) {
  return (
    <>
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
    </>
  );
}

function RunFooter({
  running,
  canRun,
  hasSummary,
  onClose,
  onRun,
  onCancel,
}: {
  running: boolean;
  canRun: boolean;
  hasSummary: boolean;
  onClose: () => void;
  onRun: () => void;
  onCancel: () => void;
}) {
  return (
    <DialogFooter>
      {running ? (
        <Button variant="destructive" onClick={onCancel} type="button">
          <X className="size-3.5" />
          Cancel
        </Button>
      ) : (
        <>
          <Button variant="ghost" onClick={onClose} type="button">
            Close
          </Button>
          <Button onClick={onRun} type="button" disabled={!canRun}>
            {hasSummary ? "Run again" : "Export"}
          </Button>
        </>
      )}
    </DialogFooter>
  );
}
