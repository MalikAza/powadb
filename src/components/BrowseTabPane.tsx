import {
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { ipc } from "../ipc";
import { type BrowseTab, newQueryId, useTabs } from "../stores/tabs";
import type { Column, DbKind, QueryResult, SavedConnection } from "../types";
import { filterToSql, parseFilter, quoteIdent, quoteTable } from "../utils/sql";
import { ConfirmDialog } from "./ConfirmDialog";
import { GeometryMapDialog, type GeometryMapInput } from "./GeometryMap";

const GEO_TYPES = new Set(["geometry", "geography"]);

function isGeoColumn(kind: DbKind, c: Column): boolean {
  return kind === "postgres" && GEO_TYPES.has(c.type_name.toLowerCase());
}

function formatPkValue(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "string") return `'${v.replace(/'/g, "''")}'`;
  return String(v);
}

function pkLabelFor(pkColIndexes: number[] | null, cols: Column[], row: unknown[]): string | null {
  if (!pkColIndexes || pkColIndexes.length === 0) return null;
  return pkColIndexes.map((idx) => `${cols[idx].name} = ${formatPkValue(row[idx])}`).join(", ");
}

type Props = {
  tab: BrowseTab;
  conn: SavedConnection;
};

export function BrowseTabPane({ tab, conn }: Props) {
  const patchTab = useTabs((s) => s.patchTab);

  const refresh = useCallback(async () => {
    const queryId = newQueryId();
    patchTab(tab.id, { loading: true, error: null });
    try {
      const where = buildWhereClause(tab, conn.kind);
      const orderBy = tab.sortCol
        ? ` ORDER BY ${quoteIdent(tab.sortCol, conn.kind)} ${tab.sortDir.toUpperCase()}`
        : "";
      const sql = `SELECT * FROM ${quoteTable(tab.schema, tab.table, conn.kind)}${where}${orderBy} LIMIT ${tab.limit} OFFSET ${tab.offset}`;
      const result = await ipc.runQuery(conn.id, queryId, sql);
      patchTab(tab.id, { result, loading: false });
    } catch (e) {
      patchTab(tab.id, { error: String(e), loading: false });
    }
  }, [tab, conn, patchTab]);

  useEffect(() => {
    refresh();
  }, [tab.filters, tab.sortCol, tab.sortDir, tab.limit, tab.offset]);

  useEffect(() => {
    if (tab.pkCols !== null) return;
    ipc
      .getPrimaryKeyColumns(conn.id, tab.schema, tab.table)
      .then((cols) => patchTab(tab.id, { pkCols: cols }))
      .catch(() => patchTab(tab.id, { pkCols: [] }));
  }, [tab.id, tab.pkCols, conn.id, tab.schema, tab.table, patchTab]);

  function setFilter(col: string, value: string) {
    patchTab(tab.id, {
      filters: { ...tab.filters, [col]: value },
      offset: 0,
    });
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

      {tab.result && !tab.error && (
        <BrowseGrid
          tab={tab}
          conn={conn}
          result={tab.result}
          onSort={toggleSort}
          onFilter={setFilter}
          onRefresh={refresh}
        />
      )}
    </div>
  );
}

function buildWhereClause(tab: BrowseTab, kind: DbKind): string {
  const parts: string[] = [];
  for (const [col, val] of Object.entries(tab.filters)) {
    const f = parseFilter(val);
    if (f) parts.push(filterToSql(col, f, kind));
  }
  if (parts.length === 0) return "";
  return ` WHERE ${parts.join(" AND ")}`;
}

function BrowseHeader({
  tab,
  conn,
  onRefresh,
}: {
  tab: BrowseTab;
  conn: SavedConnection;
  onRefresh: () => void;
}) {
  const patchTab = useTabs((s) => s.patchTab);
  const rowCount = tab.result?.rows.length ?? 0;
  const startRow = tab.offset + (rowCount > 0 ? 1 : 0);
  const endRow = tab.offset + rowCount;
  const hasMore = rowCount === tab.limit;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="font-mono text-sm">
        {conn.kind === "postgres" && <span className="text-muted-foreground">{tab.schema}.</span>}
        <span className="font-semibold">{tab.table}</span>
      </span>

      <Button size="sm" variant="ghost" onClick={onRefresh} disabled={tab.loading}>
        <RefreshCw className={tab.loading ? "size-3.5 animate-spin" : "size-3.5"} />
      </Button>

      <div className="ml-auto flex items-center gap-2 text-xs">
        <span className="text-muted-foreground">Limit</span>
        <Select
          value={String(tab.limit)}
          onValueChange={(v) => patchTab(tab.id, { limit: Number(v), offset: 0 })}
        >
          <SelectTrigger className="h-7 w-20 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="100">100</SelectItem>
            <SelectItem value="500">500</SelectItem>
            <SelectItem value="1000">1000</SelectItem>
            <SelectItem value="5000">5000</SelectItem>
          </SelectContent>
        </Select>

        <Button
          size="icon"
          variant="ghost"
          className="size-7"
          disabled={tab.offset === 0 || tab.loading}
          onClick={() => patchTab(tab.id, { offset: Math.max(0, tab.offset - tab.limit) })}
        >
          <ChevronLeft className="size-3.5" />
        </Button>
        <span className="min-w-24 text-center text-muted-foreground">
          {rowCount > 0 ? `${startRow}–${endRow}` : "—"}
        </span>
        <Button
          size="icon"
          variant="ghost"
          className="size-7"
          disabled={!hasMore || tab.loading}
          onClick={() => patchTab(tab.id, { offset: tab.offset + tab.limit })}
        >
          <ChevronRight className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}

function BrowseGrid({
  tab,
  conn,
  result,
  onSort,
  onFilter,
  onRefresh,
}: {
  tab: BrowseTab;
  conn: SavedConnection;
  result: QueryResult;
  onSort: (col: string) => void;
  onFilter: (col: string, value: string) => void;
  onRefresh: () => void;
}) {
  const [editing, setEditing] = useState<{ row: number; col: number; value: string } | null>(null);
  const [insertRow, setInsertRow] = useState<(string | null)[] | null>(null);
  const [pendingDeleteRow, setPendingDeleteRow] = useState<number | null>(null);
  const [pendingBulkDelete, setPendingBulkDelete] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const [opError, setOpError] = useState<string | null>(null);
  const [mapDialog, setMapDialog] = useState<GeometryMapInput | null>(null);

  // Reset selection whenever the underlying result changes.
  useEffect(() => {
    setSelected(new Set());
  }, [result]);

  const canEdit = (tab.pkCols?.length ?? 0) > 0;
  const cols = result.columns;
  const selectedCount = selected.size;
  const allSelected = selectedCount > 0 && selectedCount === result.rows.length;
  const headerCheckState: boolean | "indeterminate" = allSelected
    ? true
    : selectedCount > 0
      ? "indeterminate"
      : false;

  const pkColIndexes = useMemo(() => {
    if (!tab.pkCols) return null;
    const idxs: number[] = [];
    for (const pk of tab.pkCols) {
      const i = cols.findIndex((c) => c.name === pk);
      if (i === -1) return null;
      idxs.push(i);
    }
    return idxs;
  }, [tab.pkCols, cols]);

  function toggleRow(rowIdx: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(rowIdx)) next.delete(rowIdx);
      else next.add(rowIdx);
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) =>
      prev.size === result.rows.length ? new Set() : new Set(result.rows.map((_, i) => i)),
    );
  }

  async function commitEdit() {
    if (!editing || !canEdit || !tab.pkCols) {
      setEditing(null);
      return;
    }
    const { row, col, value } = editing;
    const colName = cols[col].name;
    const oldRow = result.rows[row];
    const original = oldRow[col];

    const newVal = value === "" && original === null ? "" : value;
    if (String(original ?? "") === newVal) {
      setEditing(null);
      return;
    }

    try {
      const setPlaceholder = castPlaceholder(
        conn.kind === "postgres" ? "$1" : "?",
        cols[col].type_name,
        conn.kind,
      );
      const setClause = `${quoteIdent(colName, conn.kind)} = ${setPlaceholder}`;
      const wherePieces: string[] = [];
      const params: (string | null)[] = [value];
      let pIdx = 2;
      for (const pkCol of tab.pkCols) {
        const idx = cols.findIndex((c) => c.name === pkCol);
        if (idx === -1) throw new Error(`PK column ${pkCol} not in result`);
        const placeholder = conn.kind === "postgres" ? `$${pIdx}` : "?";
        wherePieces.push(pkEq(pkCol, placeholder, conn.kind));
        params.push(stringifyValue(oldRow[idx]));
        pIdx++;
      }
      const sql = `UPDATE ${quoteTable(tab.schema, tab.table, conn.kind)} SET ${setClause} WHERE ${wherePieces.join(" AND ")}`;
      await ipc.executeDml(conn.id, sql, params);
      setEditing(null);
      setOpError(null);
      onRefresh();
    } catch (e) {
      setOpError(String(e));
    }
  }

  async function commitInsert() {
    if (!insertRow) return;
    try {
      const colNames: string[] = [];
      const placeholders: string[] = [];
      const params: (string | null)[] = [];
      let pIdx = 1;
      cols.forEach((c, i) => {
        const v = insertRow[i];
        if (v === null || v === "") return;
        colNames.push(quoteIdent(c.name, conn.kind));
        const ph = conn.kind === "postgres" ? `$${pIdx}` : "?";
        placeholders.push(castPlaceholder(ph, c.type_name, conn.kind));
        params.push(v);
        pIdx++;
      });
      if (colNames.length === 0) {
        throw new Error("All cells are empty — fill at least one column");
      }
      const sql = `INSERT INTO ${quoteTable(tab.schema, tab.table, conn.kind)} (${colNames.join(", ")}) VALUES (${placeholders.join(", ")})`;
      await ipc.executeDml(conn.id, sql, params);
      setInsertRow(null);
      setOpError(null);
      onRefresh();
    } catch (e) {
      setOpError(String(e));
    }
  }

  async function deleteSelectedRows() {
    if (!canEdit || !tab.pkCols || !pkColIndexes || selected.size === 0) return;
    try {
      const rowIdxs = [...selected].sort((a, b) => a - b);
      const placeholder = (i: number) => (conn.kind === "postgres" ? `$${i}` : "?");
      const orPieces: string[] = [];
      const params: (string | null)[] = [];
      let pIdx = 1;
      for (const ri of rowIdxs) {
        const row = result.rows[ri];
        if (!row) continue;
        const andPieces: string[] = [];
        tab.pkCols.forEach((pk, k) => {
          andPieces.push(pkEq(pk, placeholder(pIdx), conn.kind));
          params.push(stringifyValue(row[pkColIndexes[k]]));
          pIdx++;
        });
        orPieces.push(`(${andPieces.join(" AND ")})`);
      }
      if (orPieces.length === 0) return;
      const sql = `DELETE FROM ${quoteTable(tab.schema, tab.table, conn.kind)} WHERE ${orPieces.join(" OR ")}`;
      await ipc.executeDml(conn.id, sql, params);
      setSelected(new Set());
      setPendingBulkDelete(false);
      setOpError(null);
      onRefresh();
    } catch (e) {
      setOpError(String(e));
    }
  }

  async function deleteRow(rowIdx: number) {
    if (!canEdit || !tab.pkCols) return;
    try {
      const oldRow = result.rows[rowIdx];
      const wherePieces: string[] = [];
      const params: (string | null)[] = [];
      let pIdx = 1;
      for (const pkCol of tab.pkCols) {
        const idx = cols.findIndex((c) => c.name === pkCol);
        if (idx === -1) throw new Error(`PK column ${pkCol} not in result`);
        const placeholder = conn.kind === "postgres" ? `$${pIdx}` : "?";
        wherePieces.push(pkEq(pkCol, placeholder, conn.kind));
        params.push(stringifyValue(oldRow[idx]));
        pIdx++;
      }
      const sql = `DELETE FROM ${quoteTable(tab.schema, tab.table, conn.kind)} WHERE ${wherePieces.join(" AND ")}`;
      await ipc.executeDml(conn.id, sql, params);
      setPendingDeleteRow(null);
      setOpError(null);
      onRefresh();
    } catch (e) {
      setOpError(String(e));
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-2 flex items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            setInsertRow(cols.map(() => null));
            setOpError(null);
          }}
          disabled={insertRow !== null}
        >
          <Plus className="size-3.5" /> Insert row
        </Button>
        {selectedCount > 0 && canEdit && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setPendingBulkDelete(true)}
            title={`Delete ${selectedCount} selected row${selectedCount === 1 ? "" : "s"}`}
          >
            <Trash2 className="size-3.5" />
            {`Delete ${selectedCount} selected`}
          </Button>
        )}
        {selectedCount > 0 && (
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            Clear selection
          </Button>
        )}
        {!canEdit && tab.pkCols !== null && (
          <span className="text-xs text-muted-foreground">
            No primary key — edit / delete disabled
          </span>
        )}
      </div>

      {opError && (
        <pre className="mb-2 m-0 whitespace-pre-wrap rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
          {opError}
        </pre>
      )}

      <div className="min-h-0 flex-1 overflow-auto rounded-md border border-border bg-card">
        <table className="w-full border-collapse font-mono text-xs">
          <thead className="sticky top-0 z-10 bg-muted">
            <tr>
              <th className="w-8 border-b border-r border-border px-2 py-1.5 text-left">
                {canEdit && result.rows.length > 0 && (
                  <Checkbox
                    checked={headerCheckState}
                    onCheckedChange={() => toggleAll()}
                    aria-label="Select all rows"
                  />
                )}
              </th>
              <th className="w-8 border-b border-r border-border px-2 py-1.5 text-left"></th>
              {cols.map((c, colIdx) => {
                const isGeo = isGeoColumn(conn.kind, c);
                const headerInner = (
                  <>
                    <div className="flex items-center gap-1">
                      {tab.pkCols?.includes(c.name) && (
                        <span title="Primary key" className="text-primary">
                          🔑
                        </span>
                      )}
                      <span className="font-medium">{c.name}</span>
                      {tab.sortCol === c.name &&
                        (tab.sortDir === "asc" ? (
                          <ArrowUp className="size-3 text-primary" />
                        ) : (
                          <ArrowDown className="size-3 text-primary" />
                        ))}
                    </div>
                    <div className="text-[10px] font-normal text-muted-foreground">
                      {c.type_name}
                    </div>
                  </>
                );
                const th = (
                  <th
                    key={c.name}
                    className="cursor-pointer whitespace-nowrap border-b border-r border-border px-3 py-1.5 text-left hover:bg-muted-foreground/10"
                    onClick={() => onSort(c.name)}
                  >
                    {headerInner}
                  </th>
                );
                if (!isGeo) return th;
                const nonNull = result.rows.reduce(
                  (acc, row) =>
                    typeof row[colIdx] === "string" && row[colIdx] !== "" ? acc + 1 : acc,
                  0,
                );
                return (
                  <ContextMenu key={c.name}>
                    <ContextMenuTrigger asChild>{th}</ContextMenuTrigger>
                    <ContextMenuContent>
                      <ContextMenuItem
                        disabled={nonNull === 0}
                        onSelect={() => {
                          const values: Array<{
                            rowIndex: number;
                            pkLabel: string | null;
                            ewkbHex: string;
                          }> = [];
                          result.rows.forEach((row, rowIndex) => {
                            const v = row[colIdx];
                            if (typeof v === "string" && v !== "") {
                              values.push({
                                rowIndex,
                                pkLabel: pkLabelFor(pkColIndexes, cols, row),
                                ewkbHex: v,
                              });
                            }
                          });
                          if (values.length > 0) {
                            setMapDialog({
                              kind: "multi",
                              title: `${c.name} · all rows`,
                              columns: [{ name: c.name, values }],
                            });
                          }
                        }}
                      >
                        Show all on map ({nonNull})
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                );
              })}
            </tr>
            <tr>
              <th className="border-b border-r border-border px-1 py-1"></th>
              <th className="border-b border-r border-border px-1 py-1"></th>
              {cols.map((c) => (
                <th key={c.name} className="border-b border-r border-border px-1 py-1">
                  <Input
                    value={tab.filters[c.name] ?? ""}
                    onChange={(e) => onFilter(c.name, e.target.value)}
                    placeholder="filter…"
                    className="h-6 px-1.5 text-[11px]"
                  />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {insertRow && (
              <tr className="bg-primary/10">
                <td className="border-b border-r border-border px-1 py-0.5"></td>
                <td className="border-b border-r border-border px-1 py-0.5">
                  <div className="flex gap-0.5">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-5"
                      onClick={commitInsert}
                      title="Save"
                    >
                      <Save className="size-3 text-primary" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-5"
                      onClick={() => setInsertRow(null)}
                      title="Cancel"
                    >
                      <X className="size-3" />
                    </Button>
                  </div>
                </td>
                {cols.map((_c, i) => (
                  <td key={i} className="border-b border-r border-border p-0">
                    <Input
                      value={insertRow[i] ?? ""}
                      onChange={(e) => {
                        const next = [...insertRow];
                        next[i] = e.target.value === "" ? null : e.target.value;
                        setInsertRow(next);
                      }}
                      placeholder="(empty)"
                      className="h-7 rounded-none border-0 px-2 text-[11px] focus-visible:ring-0"
                    />
                  </td>
                ))}
              </tr>
            )}
            {result.rows.map((row, rowIdx) => {
              const isSelected = selected.has(rowIdx);
              return (
                <tr
                  key={rowIdx}
                  className={cn(
                    isSelected ? "bg-primary/10" : rowIdx % 2 === 0 ? "bg-card" : "bg-muted/30",
                  )}
                >
                  <ContextMenu>
                    <ContextMenuTrigger asChild>
                      <td className="border-b border-r border-border px-2 py-0.5">
                        {canEdit && (
                          <Checkbox
                            checked={isSelected}
                            onCheckedChange={() => toggleRow(rowIdx)}
                            aria-label={`Select row ${rowIdx + 1}`}
                          />
                        )}
                      </td>
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      <ContextMenuItem
                        disabled={selected.size === 0}
                        onSelect={() => {
                          const geoCols = cols
                            .map((c, i) => ({ c, i }))
                            .filter(({ c }) => isGeoColumn(conn.kind, c));
                          if (geoCols.length === 0 || selected.size === 0) return;
                          const selRows = [...selected];
                          const columns = geoCols
                            .map(({ c, i: colIdx }) => ({
                              name: c.name,
                              values: selRows
                                .map((rIdx) => {
                                  const r = result.rows[rIdx];
                                  const v = r[colIdx];
                                  if (typeof v !== "string" || v === "") return null;
                                  return {
                                    rowIndex: rIdx,
                                    pkLabel: pkLabelFor(pkColIndexes, cols, r),
                                    ewkbHex: v,
                                  };
                                })
                                .filter(
                                  (
                                    v,
                                  ): v is {
                                    rowIndex: number;
                                    pkLabel: string | null;
                                    ewkbHex: string;
                                  } => v !== null,
                                ),
                            }))
                            .filter((c) => c.values.length > 0);
                          if (columns.length === 0) return;
                          setMapDialog({
                            kind: "multi",
                            title: `${selected.size} row${selected.size === 1 ? "" : "s"}`,
                            columns,
                          });
                        }}
                      >
                        Show {selected.size} selected on map
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                  <td className="border-b border-r border-border px-1 py-0.5">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-5"
                      disabled={!canEdit}
                      title={!canEdit ? "No primary key — delete disabled" : "Delete"}
                      onClick={() => setPendingDeleteRow(rowIdx)}
                    >
                      <Trash2 className="size-3" />
                    </Button>
                  </td>
                  {row.map((v, colIdx) => {
                    const isEditing = editing?.row === rowIdx && editing?.col === colIdx;
                    const col = cols[colIdx];
                    const isGeo = isGeoColumn(conn.kind, col);
                    const canOpenMap = isGeo && typeof v === "string" && v !== "";
                    return (
                      <td
                        key={colIdx}
                        className="border-b border-r border-border p-0"
                        onDoubleClick={() => {
                          if (!canEdit) return;
                          setEditing({
                            row: rowIdx,
                            col: colIdx,
                            value: v === null || v === undefined ? "" : String(v),
                          });
                        }}
                      >
                        {isEditing ? (
                          <CellEditor
                            value={editing.value}
                            onChange={(value) => setEditing({ ...editing, value })}
                            onCommit={commitEdit}
                            onCancel={() => setEditing(null)}
                          />
                        ) : canOpenMap ? (
                          <GeometryCell
                            value={v as string}
                            onOpen={() =>
                              setMapDialog({
                                kind: "single",
                                columnName: col.name,
                                ewkbHex: v as string,
                              })
                            }
                          />
                        ) : (
                          <div className="overflow-hidden text-ellipsis whitespace-nowrap px-3 py-1">
                            {v === null || v === undefined ? (
                              <span className="text-muted-foreground/60">NULL</span>
                            ) : typeof v === "object" ? (
                              JSON.stringify(v)
                            ) : (
                              String(v)
                            )}
                          </div>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <ConfirmDialog
        open={pendingDeleteRow !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDeleteRow(null);
        }}
        title="Delete this row?"
        description="The row will be permanently removed from the table."
        confirmLabel="Delete"
        onConfirm={() => {
          if (pendingDeleteRow !== null) deleteRow(pendingDeleteRow);
        }}
      />

      <ConfirmDialog
        open={pendingBulkDelete}
        onOpenChange={(open) => {
          if (!open) setPendingBulkDelete(false);
        }}
        title={`Delete ${selectedCount} selected row${selectedCount === 1 ? "" : "s"}?`}
        description="The selected rows will be permanently removed from the table."
        confirmLabel="Delete"
        onConfirm={deleteSelectedRows}
      />

      {mapDialog && (
        <GeometryMapDialog
          open={true}
          onOpenChange={(o) => {
            if (!o) setMapDialog(null);
          }}
          connectionId={conn.id}
          input={mapDialog}
        />
      )}
    </div>
  );
}

function GeometryCell({ value, onOpen }: { value: string; onOpen: () => void }) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className="cursor-context-menu overflow-hidden text-ellipsis whitespace-nowrap px-3 py-1">
          {value}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={onOpen}>Open in map</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function CellEditor({
  value,
  onChange,
  onCommit,
  onCancel,
}: {
  value: string;
  onChange: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <Input
      ref={ref}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onCommit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onCommit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
      className="h-7 rounded-none border-0 bg-primary/20 px-3 text-[11px] focus-visible:ring-1 focus-visible:ring-primary"
    />
  );
}

function stringifyValue(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

// Postgres rejects `int_col = $1` when $1 is bound as text (no implicit cast).
// We always send DML params as strings, so cast the column to text on PG to make
// equality work for any column type. MySQL doesn't need this — it coerces freely.
function pkEq(col: string, placeholder: string, kind: DbKind): string {
  const ident = quoteIdent(col, kind);
  return kind === "postgres" ? `${ident}::text = ${placeholder}` : `${ident} = ${placeholder}`;
}

// Mirror of pkEq for the assignment side: PG won't implicitly cast text → timestamp,
// int4, uuid, etc. The sqlx type_info name (TIMESTAMP, INT4, TIMESTAMPTZ, …) is also
// a valid PG typname for `::cast`, so lowercasing it produces the right cast.
function castPlaceholder(placeholder: string, typeName: string | undefined, kind: DbKind): string {
  if (kind !== "postgres" || !typeName) return placeholder;
  const t = typeName.toUpperCase();
  if (
    t === "TEXT" ||
    t === "VARCHAR" ||
    t === "CHAR" ||
    t === "BPCHAR" ||
    t === "NAME" ||
    t === "CITEXT" ||
    t === "UNKNOWN"
  ) {
    return placeholder;
  }
  return `${placeholder}::${typeName.toLowerCase()}`;
}
