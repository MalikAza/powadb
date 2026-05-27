import { useCallback, useEffect, useState } from "react";
import { useColumnDisplay } from "@/stores/columnDisplay";
import { type DiagFk, ipc } from "../ipc";
import { type BrowseTab, newQueryId, useTabs } from "../stores/tabs";
import type { SavedConnection } from "../types";
import { mongoDocumentsToQueryResult, mongoFiltersFromTab, mongoSortFromTab } from "../utils/mongo";
import { type Filter, quoteIdent, quoteTable } from "../utils/sql";
import { BrowseGrid } from "./BrowseTabPane/BrowseGrid";
import { BrowseHeader } from "./BrowseTabPane/BrowseHeader";
import { buildWhereClause } from "./BrowseTabPane/helpers";

type Props = {
  tab: BrowseTab;
  conn: SavedConnection;
};

export function BrowseTabPane({ tab, conn }: Props) {
  const patchTab = useTabs((s) => s.patchTab);
  const [fks, setFks] = useState<DiagFk[]>([]);
  const byteaModes = useColumnDisplay((s) => s.byteaModes);

  const refresh = useCallback(async () => {
    const queryId = newQueryId();
    patchTab(tab.id, { loading: true, error: null });
    try {
      if (conn.kind === "mongo") {
        // Mongo branch: tab.schema is the database name, tab.table is the
        // collection. The SQL filter UI doesn't translate yet — we send a
        // bare find({}) with paging. Sorting is also SQL-only for now.
        const er = await ipc.runEngineQuery(conn.id, queryId, {
          kind: "mongo",
          value: {
            op: "find",
            collection: tab.table,
            database: tab.schema,
            filter: mongoFiltersFromTab(tab),
            sort: mongoSortFromTab(tab),
            limit: tab.limit,
            skip: tab.offset,
          },
        });
        if (er.kind !== "documents") {
          throw new Error(`Mongo find returned unexpected result kind: ${er.kind}`);
        }
        const result = mongoDocumentsToQueryResult(
          er.docs as Record<string, unknown>[],
          er.elapsed_ms,
        );
        patchTab(tab.id, { result, loading: false });
        return;
      }
      const cols = tab.result?.columns ?? [];
      const where = buildWhereClause(tab, conn, cols, byteaModes);
      const orderBy = tab.sortCol
        ? ` ORDER BY ${quoteIdent(tab.sortCol, conn.kind)} ${tab.sortDir.toUpperCase()}`
        : "";
      const sql = `SELECT * FROM ${quoteTable(tab.schema, tab.table, conn.kind)}${where}${orderBy} LIMIT ${tab.limit} OFFSET ${tab.offset}`;
      const result = await ipc.runQuery(conn.id, queryId, sql);
      patchTab(tab.id, { result, loading: false });
    } catch (e) {
      patchTab(tab.id, { error: String(e), loading: false });
    }
  }, [tab, conn, patchTab, byteaModes]);

  useEffect(() => {
    refresh();
  }, [tab.filters, tab.sortCol, tab.sortDir, tab.limit, tab.offset]);

  useEffect(() => {
    if (tab.pkCols !== null) return;
    // Mongo has implicit _id as the primary key — no need to query the server.
    if (conn.kind === "mongo") {
      patchTab(tab.id, { pkCols: ["_id"] });
      return;
    }
    ipc
      .getPrimaryKeyColumns(conn.id, tab.schema, tab.table)
      .then((cols) => patchTab(tab.id, { pkCols: cols }))
      .catch(() => patchTab(tab.id, { pkCols: [] }));
  }, [tab.id, tab.pkCols, conn.id, conn.kind, tab.schema, tab.table, patchTab]);

  useEffect(() => {
    let cancelled = false;
    // Foreign keys don't exist in Mongo; resolve to an empty list without IPC.
    const promise: Promise<DiagFk[]> =
      conn.kind === "mongo"
        ? Promise.resolve([])
        : ipc.listForeignKeys(conn.id, tab.schema, tab.table).catch(() => []);
    promise.then((next) => {
      if (!cancelled) setFks(next);
    });
    return () => {
      cancelled = true;
    };
  }, [conn.id, conn.kind, tab.schema, tab.table]);

  function setFilter(col: string, filter: Filter | null) {
    const next = { ...tab.filters };
    if (filter === null) delete next[col];
    else next[col] = filter;
    patchTab(tab.id, { filters: next, offset: 0 });
  }

  function toggleSort(col: string) {
    if (tab.sortCol !== col) {
      patchTab(tab.id, { sortCol: col, sortDir: "asc", offset: 0 });
    } else if (tab.sortDir === "asc") {
      patchTab(tab.id, { sortDir: "desc" });
    } else {
      patchTab(tab.id, { sortCol: null, sortDir: "asc" });
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
      <BrowseHeader tab={tab} conn={conn} onRefresh={refresh} />

      {tab.error && (
        <pre className="m-0 whitespace-pre-wrap rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
          {tab.error}
        </pre>
      )}

      {tab.result && (
        <BrowseGrid
          tab={tab}
          conn={conn}
          result={tab.result}
          fks={fks}
          onSort={toggleSort}
          onFilter={setFilter}
          onRefresh={refresh}
        />
      )}
    </div>
  );
}
