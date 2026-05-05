import { Pause, Play, Sparkles } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ipc } from "../ipc";
import { newQueryId, type QueryTab, useTabs } from "../stores/tabs";
import type { SavedConnection } from "../types";
import { toCsv, toJson, toTsv } from "../utils/format";
import { ExplainView, isExplainResult, wrapAsExplain } from "./ExplainView";
import { ResultsGrid } from "./ResultsGrid/Grid";

const SqlEditor = lazy(() =>
  import("./Editor/SqlEditor").then((m) => ({ default: m.SqlEditor })),
);

type Props = {
  tab: QueryTab;
  conn: SavedConnection;
};

export function QueryTabPane({ tab, conn }: Props) {
  const patchTab = useTabs((s) => s.patchTab);

  const runSql = useCallback(
    async (sql: string) => {
      const queryId = newQueryId();
      patchTab(tab.id, {
        loading: true,
        error: null,
        result: null,
        runningQueryId: queryId,
      });
      try {
        const result = await ipc.runQuery(conn.id, queryId, sql);
        patchTab(tab.id, { result, loading: false, runningQueryId: null });
      } catch (e) {
        patchTab(tab.id, { error: String(e), loading: false, runningQueryId: null });
      }
    },
    [tab.id, conn.id, patchTab],
  );

  const run = useCallback(() => runSql(tab.sql), [runSql, tab.sql]);
  const explain = useCallback(
    (analyze: boolean) => runSql(wrapAsExplain(tab.sql, conn.kind, analyze)),
    [runSql, tab.sql, conn.kind],
  );
  const cancel = useCallback(async () => {
    if (!tab.runningQueryId) return;
    await ipc.cancelQuery(tab.runningQueryId);
  }, [tab.runningQueryId]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === ".") {
        e.preventDefault();
        cancel();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cancel]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
      <div className="flex h-[200px] shrink-0 overflow-hidden rounded-md border border-border">
        <Suspense fallback={<div className="flex-1" />}>
          <SqlEditor
            value={tab.sql}
            onChange={(v) => patchTab(tab.id, { sql: v })}
            onRun={run}
            kind={conn.kind}
          />
        </Suspense>
      </div>

      <div className="flex items-center gap-2">
        {tab.loading ? (
          <Button onClick={cancel} variant="destructive" size="sm">
            <Pause className="size-3.5" /> Cancel
            <kbd className="ml-1 rounded bg-black/30 px-1 font-mono text-[10px]">⌘.</kbd>
          </Button>
        ) : (
          <>
            <Button onClick={run} size="sm">
              <Play className="size-3.5" /> Run
              <kbd className="ml-1 rounded bg-black/30 px-1 font-mono text-[10px]">⌘↵</kbd>
            </Button>
            <Button onClick={() => explain(false)} size="sm" variant="secondary">
              <Sparkles className="size-3.5" /> Explain
            </Button>
            {conn.kind === "postgres" && (
              <Button onClick={() => explain(true)} size="sm" variant="secondary">
                Explain Analyze
              </Button>
            )}
          </>
        )}
        {tab.result && !tab.error && (
          <span className="ml-auto text-xs text-muted-foreground">
            {tab.result.rows.length} row(s) · {tab.result.elapsed_ms} ms
          </span>
        )}
      </div>

      {tab.error && (
        <pre className="m-0 whitespace-pre-wrap rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
          {tab.error}
        </pre>
      )}

      {tab.result &&
        !tab.error &&
        (isExplainResult(tab.result) ? (
          <ExplainView result={tab.result} />
        ) : (
          <>
            <CopyBar
              onCopyTsv={() => navigator.clipboard.writeText(toTsv(tab.result!))}
              onCopyCsv={() => navigator.clipboard.writeText(toCsv(tab.result!))}
              onCopyJson={() => navigator.clipboard.writeText(toJson(tab.result!))}
            />
            <ResultsGrid result={tab.result} />
          </>
        ))}
    </div>
  );
}

function CopyBar({
  onCopyTsv,
  onCopyCsv,
  onCopyJson,
}: {
  onCopyTsv: () => void;
  onCopyCsv: () => void;
  onCopyJson: () => void;
}) {
  const [flash, setFlash] = useState<string | null>(null);
  function handle(label: string, fn: () => void) {
    fn();
    setFlash(label);
    setTimeout(() => setFlash(null), 1200);
  }
  return (
    <div className="flex items-center gap-1 text-xs">
      <span className="mr-1 text-muted-foreground">Copy:</span>
      <Button
        size="sm"
        variant="ghost"
        className="h-6 px-2 text-xs"
        onClick={() => handle("tsv", onCopyTsv)}
      >
        TSV
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="h-6 px-2 text-xs"
        onClick={() => handle("csv", onCopyCsv)}
      >
        CSV
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="h-6 px-2 text-xs"
        onClick={() => handle("json", onCopyJson)}
      >
        JSON
      </Button>
      {flash && <span className="text-muted-foreground">copied {flash}</span>}
    </div>
  );
}
