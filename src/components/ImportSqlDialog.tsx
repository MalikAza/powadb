import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  AlertTriangle,
  CheckCircle2,
  Database,
  FolderOpen,
  Loader2,
  Wrench,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
import { cn } from "@/lib/utils";
import {
  type DumpEngine,
  type DumpProgressEvent,
  type ImportSummary,
  ipc,
  type ToolStatus,
} from "../ipc";
import { useConnections } from "../stores/connections";
import { useUi } from "../stores/ui";

export function ImportSqlDialog() {
  const dialog = useUi((s) => s.importDialog);
  const close = useUi((s) => s.closeImportDialog);
  const open = !!dialog;
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) close();
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        {dialog && <ImportSqlDialogBody connectionId={dialog.connectionId} onDone={close} />}
      </DialogContent>
    </Dialog>
  );
}

function ImportSqlDialogBody({
  connectionId,
  onDone,
}: {
  connectionId: string;
  onDone: () => void;
}) {
  const conn = useConnections((s) => s.connections.find((c) => c.id === connectionId));

  const [tools, setTools] = useState<ToolStatus | null>(null);
  const [engine, setEngine] = useState<DumpEngine>("tool");
  const [inputPath, setInputPath] = useState("");
  const [singleTransaction, setSingleTransaction] = useState(true);
  const [confirmed, setConfirmed] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<DumpProgressEvent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const jobIdRef = useRef<string>("");

  useEffect(() => {
    if (!conn) return;
    ipc.checkDumpTools(conn.kind).then((status) => {
      setTools(status);
      if (!status.client) setEngine("native");
    });
  }, [conn?.kind]);

  async function pickPath() {
    const picked = await ipc.pickOpenPath();
    if (picked) setInputPath(picked);
  }

  async function run() {
    if (!conn || !inputPath || !confirmed) return;
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
      const result = await ipc.importSql(conn.id, inputPath, {
        engine,
        single_transaction: singleTransaction,
        job_id: jobId,
      });
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

  const toolMissing = engine === "tool" && !tools?.client;

  return (
    <>
      <DialogHeader>
        <DialogTitle>Import SQL — {conn.name}</DialogTitle>
      </DialogHeader>

      <div className="grid gap-4">
        <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <div>
            This will execute SQL against{" "}
            <span className="font-mono font-semibold">
              {conn.username}@{conn.host}:{conn.port}/{conn.database}
            </span>{" "}
            and may modify or destroy existing data. Make sure you have a backup before continuing.
          </div>
        </div>

        <Section title="Engine">
          <div className="grid grid-cols-2 gap-2">
            <EngineCard
              icon={<Wrench className="size-4" />}
              label="Tool"
              hint={
                tools?.client
                  ? `Uses ${conn.kind === "postgres" ? "psql" : "mysql"}`
                  : "Not found on PATH — set its path in Settings"
              }
              selected={engine === "tool"}
              disabled={running}
              onSelect={() => setEngine("tool")}
            />
            <EngineCard
              icon={<Database className="size-4" />}
              label="Native"
              hint="Built-in. Splits and runs each statement via sqlx."
              selected={engine === "native"}
              disabled={running}
              onSelect={() => setEngine("native")}
            />
          </div>
        </Section>

        {engine === "native" && (
          <Section title="Native options">
            <label htmlFor="import-single-tx" className="flex items-center gap-2 text-sm">
              <Checkbox
                id="import-single-tx"
                checked={singleTransaction}
                onCheckedChange={(v) => setSingleTransaction(Boolean(v))}
                disabled={running}
              />
              Run inside a single transaction (rollback on any error)
            </label>
          </Section>
        )}

        <Section title="SQL file">
          <div className="flex gap-2">
            <Input
              value={inputPath}
              onChange={(e) => setInputPath(e.target.value)}
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

        <label htmlFor="import-confirm" className="flex items-center gap-2 text-sm">
          <Checkbox
            id="import-confirm"
            checked={confirmed}
            onCheckedChange={(v) => setConfirmed(Boolean(v))}
            disabled={running}
          />
          I understand this will mutate the database.
        </label>

        {progress && running && (
          <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            <div className="flex items-center gap-2">
              <Loader2 className="size-3 animate-spin" />
              <span>{progress.message ?? progress.phase}</span>
            </div>
          </div>
        )}

        {error && (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <div className="font-medium">Import failed</div>
            <pre className="mt-1 whitespace-pre-wrap break-words font-mono">{error}</pre>
          </div>
        )}

        {summary && (
          <div className="flex items-center gap-2 rounded-md border border-primary/30 bg-primary/10 px-3 py-2 text-xs">
            <CheckCircle2 className="size-3.5" />
            Import finished — {summary.statements_executed.toLocaleString()} statement(s) executed.
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
              variant="destructive"
              onClick={run}
              type="button"
              disabled={!inputPath || !confirmed || toolMissing}
            >
              {summary ? "Run again" : "Run import"}
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
