import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import type { ByteaDisplayMode } from "@/lib/bytea";
import { cn } from "@/lib/utils";
import type { ScriptResult, StatementResult } from "../ipc";
import type { DbKind } from "../types";
import { ResultsGrid } from "./ResultsGrid/Grid";

type Props = {
  scriptResult: ScriptResult;
  connectionId: string;
  kind: DbKind;
  byteaModes: Record<string, ByteaDisplayMode>;
  onByteaModeChange: (colName: string, mode: ByteaDisplayMode) => void;
};

export function ScriptResults({
  scriptResult,
  connectionId,
  kind,
  byteaModes,
  onByteaModeChange,
}: Props) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-auto">
      {scriptResult.statements.map((s) => (
        <StatementRow
          key={s.index}
          statement={s}
          connectionId={connectionId}
          kind={kind}
          byteaModes={byteaModes}
          onByteaModeChange={onByteaModeChange}
        />
      ))}
    </div>
  );
}

function StatementRow({
  statement,
  connectionId,
  kind,
  byteaModes,
  onByteaModeChange,
}: {
  statement: StatementResult;
  connectionId: string;
  kind: DbKind;
  byteaModes: Record<string, ByteaDisplayMode>;
  onByteaModeChange: (colName: string, mode: ByteaDisplayMode) => void;
}) {
  const hasRows = !!statement.result;
  const hasError = !!statement.error;
  // Auto-expand errors so the user sees what failed without an extra click.
  const [open, setOpen] = useState(hasError);
  const expandable = hasRows || hasError;

  const summary = describeOutcome(statement);

  return (
    <div className="rounded-md border border-border">
      <button
        type="button"
        onClick={() => expandable && setOpen((v) => !v)}
        className={cn(
          "flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs",
          expandable ? "cursor-pointer hover:bg-muted/40" : "cursor-default",
        )}
      >
        <span className="w-4 shrink-0 text-muted-foreground">
          {expandable ? (
            open ? (
              <ChevronDown className="size-3.5" />
            ) : (
              <ChevronRight className="size-3.5" />
            )
          ) : null}
        </span>
        <span className="w-8 shrink-0 font-mono text-muted-foreground">#{statement.index + 1}</span>
        <span className="flex-1 truncate font-mono text-foreground">{statement.sql_excerpt}</span>
        <span
          className={cn("ml-2 shrink-0", hasError ? "text-destructive" : "text-muted-foreground")}
        >
          {summary}
        </span>
        <span className="ml-2 shrink-0 tabular-nums text-muted-foreground">
          {statement.elapsed_ms} ms
        </span>
      </button>

      {open && hasError && (
        <pre className="m-0 whitespace-pre-wrap border-t border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {statement.error}
        </pre>
      )}

      {open && hasRows && statement.result && (
        <div className="border-t border-border">
          <ResultsGrid
            result={statement.result}
            connectionId={connectionId}
            kind={kind}
            byteaModes={byteaModes}
            onByteaModeChange={onByteaModeChange}
          />
        </div>
      )}
    </div>
  );
}

function describeOutcome(s: StatementResult): string {
  if (s.error) return "error";
  if (s.result) {
    const n = s.result.rows.length;
    return `${n} row${n === 1 ? "" : "s"} returned`;
  }
  if (s.rows_affected !== undefined) {
    const n = s.rows_affected;
    return `${n} row${n === 1 ? "" : "s"} affected`;
  }
  return "ok";
}
