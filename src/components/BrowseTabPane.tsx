import {
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  Eye,
  Map as MapIcon,
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
import { type ByteaDisplayMode, formatBytea, parseByteaInput, stripHexPrefix } from "@/lib/bytea";
import { cn } from "@/lib/utils";
import { columnDisplayKey, useColumnDisplay } from "@/stores/columnDisplay";
import { type DecodedGeometry, type DiagFk, ipc } from "../ipc";
import { type BrowseTab, newQueryId, useTabs } from "../stores/tabs";
import type { Column, DbKind, QueryResult, SavedConnection } from "../types";
import { filterToSql, parseFilter, quoteIdent, quoteTable } from "../utils/sql";
import { type CellPreview, CellPreviewDialog } from "./CellPreviewDialog";
import { ConfirmDialog } from "./ConfirmDialog";
import { FkCell } from "./FkCell";
import { GeometryMapDialog, type GeometryMapInput } from "./GeometryMap";

// Cap any single cell at this width so geometry / long-text columns can't blow
// out the table. The full value is still reachable via the "Show full value"
// context-menu entry (and via cartography for geometry columns).
const CELL_MAX_WIDTH = "280px";

const GEO_TYPES = new Set(["geometry", "geography"]);

function isGeoColumn(kind: DbKind, c: Column): boolean {
  return kind === "postgres" && GEO_TYPES.has(c.type_name.toLowerCase());
}

function isByteaColumn(kind: DbKind, c: Column): boolean {
  // BYTEA is Postgres-only here — the MySQL `BLOB` family doesn't share the
  // `\xHEX` wire shape and would need its own decoder.
  return kind === "postgres" && c.type_name.toUpperCase() === "BYTEA";
}

type GeomDecoded = DecodedGeometry & { coordsJson: string };

function geomKey(row: number, col: number): string {
  return `${row}:${col}`;
}

function buildRowData(
  columns: Column[],
  row: readonly unknown[],
  excluded: Set<number>,
): Array<[string, unknown]> {
  const out: Array<[string, unknown]> = [];
  columns.forEach((c, i) => {
    if (excluded.has(i)) return;
    out.push([c.name, row[i]]);
  });
  return out;
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
  const [fks, setFks] = useState<DiagFk[]>([]);

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

  useEffect(() => {
    let cancelled = false;
    ipc
      .listForeignKeys(conn.id, tab.schema, tab.table)
      .then((rows) => {
        if (!cancelled) setFks(rows);
      })
      .catch(() => {
        if (!cancelled) setFks([]);
      });
    return () => {
      cancelled = true;
    };
  }, [conn.id, tab.schema, tab.table]);

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
  fks,
  onSort,
  onFilter,
  onRefresh,
}: {
  tab: BrowseTab;
  conn: SavedConnection;
  result: QueryResult;
  fks: DiagFk[];
  onSort: (col: string) => void;
  onFilter: (col: string, value: string) => void;
  onRefresh: () => void;
}) {
  const openBrowseTab = useTabs((s) => s.openBrowseTab);
  const [editing, setEditing] = useState<{ row: number; col: number; value: string } | null>(null);
  const [insertRow, setInsertRow] = useState<(string | null)[] | null>(null);
  const [pendingDeleteRow, setPendingDeleteRow] = useState<number | null>(null);
  const [pendingBulkDelete, setPendingBulkDelete] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const [opError, setOpError] = useState<string | null>(null);
  const [mapDialog, setMapDialog] = useState<GeometryMapInput | null>(null);
  const [cellPreview, setCellPreview] = useState<CellPreview | null>(null);
  const [decodedGeoms, setDecodedGeoms] = useState<Map<string, GeomDecoded>>(() => new Map());
  const byteaModes = useColumnDisplay((s) => s.byteaModes);
  const setByteaMode = useColumnDisplay((s) => s.setByteaMode);

  // Reset selection whenever the underlying result changes.
  useEffect(() => {
    setSelected(new Set());
  }, [result]);

  const canEdit = (tab.pkCols?.length ?? 0) > 0;
  const cols = result.columns;

  // Batch-decode every geometry cell in the current result so we can render
  // GeoJSON coordinates inline and remember each cell's SRID + geometry type
  // for round-tripping edits back through ST_GeomFromGeoJSON.
  useEffect(() => {
    if (conn.kind !== "postgres") {
      setDecodedGeoms(new Map());
      return;
    }
    const targets: Array<{ row: number; col: number; hex: string }> = [];
    cols.forEach((c, colIdx) => {
      if (!isGeoColumn(conn.kind, c)) return;
      result.rows.forEach((row, rowIdx) => {
        const v = row[colIdx];
        if (typeof v === "string" && v !== "") {
          targets.push({ row: rowIdx, col: colIdx, hex: v });
        }
      });
    });
    if (targets.length === 0) {
      setDecodedGeoms(new Map());
      return;
    }
    let cancelled = false;
    ipc
      .decodeGeometries(
        conn.id,
        targets.map((t) => t.hex),
      )
      .then((decoded) => {
        if (cancelled) return;
        const next = new Map<string, GeomDecoded>();
        decoded.forEach((entry, i) => {
          if (!entry) return;
          const { row, col } = targets[i];
          let coordsJson = "";
          try {
            const obj = JSON.parse(entry.geojson) as { coordinates?: unknown };
            coordsJson = JSON.stringify(obj.coordinates ?? null);
          } catch {
            coordsJson = entry.geojson;
          }
          next.set(geomKey(row, col), { ...entry, coordsJson });
        });
        setDecodedGeoms(next);
      })
      .catch(() => {
        if (!cancelled) setDecodedGeoms(new Map());
      });
    return () => {
      cancelled = true;
    };
  }, [result, cols, conn.id, conn.kind]);

  // Resolve the per-column BYTEA display mode (defaults to "hex"). Computed once
  // per render against the persisted store so re-toggling refreshes the grid.
  const byteaColMode = useMemo(() => {
    const out = new Map<number, ByteaDisplayMode>();
    cols.forEach((c, i) => {
      if (!isByteaColumn(conn.kind, c)) return;
      const k = columnDisplayKey(conn.id, tab.schema, tab.table, c.name);
      out.set(i, byteaModes[k] ?? "hex");
    });
    return out;
  }, [cols, conn.kind, conn.id, tab.schema, tab.table, byteaModes]);

  function setColByteaMode(colIdx: number, mode: ByteaDisplayMode) {
    const col = cols[colIdx];
    if (!col) return;
    const key = columnDisplayKey(conn.id, tab.schema, tab.table, col.name);
    setByteaMode(key, mode);
  }

  // Pretty-print a cell value according to its column's display preset. Returns
  // the string the cell should show; `null` for SQL NULL.
  function displayString(rowIdx: number, colIdx: number, raw: unknown): string | null {
    if (raw === null || raw === undefined) return null;
    const decoded = decodedGeoms.get(geomKey(rowIdx, colIdx));
    if (decoded) return decoded.coordsJson;
    const mode = byteaColMode.get(colIdx);
    if (mode && mode !== "hex" && typeof raw === "string") {
      const formatted = formatBytea(raw, mode);
      if (formatted !== null) return formatted;
    }
    if (typeof raw === "object") return JSON.stringify(raw);
    return String(raw);
  }
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

  const fkByColumn = useMemo(() => {
    const map = new Map<string, DiagFk>();
    for (const fk of fks) {
      for (const col of fk.from_columns) {
        if (!map.has(col)) map.set(col, fk);
      }
    }
    return map;
  }, [fks]);

  function openFkTarget(fk: DiagFk, row: unknown[]) {
    const filters: Record<string, string> = {};
    fk.from_columns.forEach((fromCol, i) => {
      const idx = cols.findIndex((c) => c.name === fromCol);
      if (idx === -1) return;
      const v = row[idx];
      if (v === null || v === undefined) return;
      const toCol = fk.to_columns[i];
      if (!toCol) return;
      filters[toCol] = `=${typeof v === "object" ? JSON.stringify(v) : String(v)}`;
    });
    if (Object.keys(filters).length === 0) return;
    openBrowseTab(conn.id, fk.to_schema, fk.to_table, filters);
  }

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
    const colDef = cols[col];
    const colName = colDef.name;
    const oldRow = result.rows[row];
    const original = oldRow[col];

    // Geometry edits are intentionally disabled (see the cell render — geo
    // cells don't open the editor). The only "decoded display" we round-trip
    // is BYTEA via UUID/ULID presets.
    const byteaMode = byteaColMode.get(col);

    try {
      let paramValue: string | null = value;
      let setExpr: string;

      const ph1 = conn.kind === "postgres" ? "$1" : "?";

      if (byteaMode && byteaMode !== "hex" && conn.kind === "postgres") {
        // BYTEA presented as UUID/ULID — parse back to hex, fall through to a
        // `decode($1, 'hex')::bytea` UPDATE. If parsing fails, bail with a
        // clear error rather than corrupting the row.
        const parsed = parseByteaInput(value, byteaMode);
        if (parsed === null) {
          throw new Error(`Invalid ${byteaMode.toUpperCase()} value`);
        }
        const oldHex = typeof original === "string" ? stripHexPrefix(original).toUpperCase() : "";
        if (parsed === oldHex) {
          setEditing(null);
          return;
        }
        paramValue = parsed;
        setExpr = `${quoteIdent(colName, conn.kind)} = decode(${ph1}, 'hex')::bytea`;
        await runUpdate(setExpr, paramValue);
        setEditing(null);
        setOpError(null);
        onRefresh();
        return;
      }

      // Default path: bind as text, cast to the column's declared type on PG.
      const newVal = value === "" && original === null ? "" : value;
      if (String(original ?? "") === newVal) {
        setEditing(null);
        return;
      }
      const setPlaceholder = castPlaceholder(ph1, colDef.type_name, conn.kind);
      setExpr = `${quoteIdent(colName, conn.kind)} = ${setPlaceholder}`;
      await runUpdate(setExpr, paramValue);
      setEditing(null);
      setOpError(null);
      onRefresh();
    } catch (e) {
      setOpError(String(e));
    }
  }

  async function runUpdate(setClause: string, firstParam: string | null) {
    if (!tab.pkCols) throw new Error("no primary key");
    const { row } = editing!;
    const oldRow = result.rows[row];
    const wherePieces: string[] = [];
    const params: (string | null)[] = [firstParam];
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
                const isBytea = isByteaColumn(conn.kind, c);
                const byteaMode = byteaColMode.get(colIdx);
                const modeBadge = isBytea && byteaMode && byteaMode !== "hex" ? byteaMode : null;
                const headerInner = (
                  <div style={{ maxWidth: CELL_MAX_WIDTH }}>
                    <div className="flex items-center gap-1 overflow-hidden">
                      {tab.pkCols?.includes(c.name) && (
                        <span title="Primary key" className="text-primary">
                          🔑
                        </span>
                      )}
                      <span className="truncate font-medium">{c.name}</span>
                      {tab.sortCol === c.name &&
                        (tab.sortDir === "asc" ? (
                          <ArrowUp className="size-3 shrink-0 text-primary" />
                        ) : (
                          <ArrowDown className="size-3 shrink-0 text-primary" />
                        ))}
                    </div>
                    <div className="flex items-center gap-1 truncate text-[10px] font-normal text-muted-foreground">
                      <span>{c.type_name}</span>
                      {modeBadge && (
                        <span className="rounded bg-primary/15 px-1 text-[9px] uppercase text-primary">
                          {modeBadge}
                        </span>
                      )}
                    </div>
                  </div>
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
                if (isBytea) {
                  return (
                    <ContextMenu key={c.name}>
                      <ContextMenuTrigger asChild>{th}</ContextMenuTrigger>
                      <ContextMenuContent>
                        <ContextMenuItem onSelect={() => setColByteaMode(colIdx, "ulid")}>
                          Display as ULID
                          {byteaMode === "ulid" && <span className="ml-auto text-primary">✓</span>}
                        </ContextMenuItem>
                        <ContextMenuItem onSelect={() => setColByteaMode(colIdx, "uuid")}>
                          Display as UUID
                          {byteaMode === "uuid" && <span className="ml-auto text-primary">✓</span>}
                        </ContextMenuItem>
                        <ContextMenuItem onSelect={() => setColByteaMode(colIdx, "hex")}>
                          Display as Hex
                          {(!byteaMode || byteaMode === "hex") && (
                            <span className="ml-auto text-primary">✓</span>
                          )}
                        </ContextMenuItem>
                      </ContextMenuContent>
                    </ContextMenu>
                  );
                }
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
                          const excluded = new Set([colIdx]);
                          const values: Array<{
                            rowIndex: number;
                            pkLabel: string | null;
                            ewkbHex: string;
                            rowData: Array<[string, unknown]>;
                          }> = [];
                          result.rows.forEach((row, rowIndex) => {
                            const v = row[colIdx];
                            if (typeof v === "string" && v !== "") {
                              values.push({
                                rowIndex,
                                pkLabel: pkLabelFor(pkColIndexes, cols, row),
                                ewkbHex: v,
                                rowData: buildRowData(cols, row, excluded),
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
                        <MapIcon className="size-3.5" />
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
                          // Exclude all geo columns from rowData — clicking a feature
                          // shouldn't surface raw EWKB hex of any geometry column.
                          const excluded = new Set(geoCols.map(({ i }) => i));
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
                                    rowData: buildRowData(cols, r, excluded),
                                  };
                                })
                                .filter(
                                  (
                                    v,
                                  ): v is {
                                    rowIndex: number;
                                    pkLabel: string | null;
                                    ewkbHex: string;
                                    rowData: Array<[string, unknown]>;
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
                        <MapIcon className="size-3.5" />
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
                    const fk = fkByColumn.get(col.name);
                    const canFollowFk = fk !== undefined && v !== null && v !== undefined;
                    const shown = displayString(rowIdx, colIdx, v);
                    const startEdit = () =>
                      setEditing({
                        row: rowIdx,
                        col: colIdx,
                        value: shown ?? "",
                      });
                    return (
                      <td
                        key={colIdx}
                        className="border-b border-r border-border p-0"
                        onDoubleClick={() => {
                          if (!canEdit) return;
                          // Geometry edits are too risky to round-trip safely
                          // (PostGIS re-encodes EWKB, which silently rewrites
                          // rows on commit even when coords look identical).
                          if (isGeo) return;
                          startEdit();
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
                            value={shown ?? (v as string)}
                            onOpen={() =>
                              setMapDialog({
                                kind: "single",
                                columnName: col.name,
                                ewkbHex: v as string,
                                rowData: buildRowData(cols, row, new Set([colIdx])),
                              })
                            }
                            onShowFull={() => {
                              // Prefer the decoded GeoJSON (parsed so the
                              // preview dialog pretty-prints it) over the raw
                              // EWKB hex, which is what the user actually wants
                              // to inspect.
                              const decoded = decodedGeoms.get(geomKey(rowIdx, colIdx));
                              let previewVal: unknown = v;
                              if (decoded) {
                                try {
                                  previewVal = JSON.parse(decoded.geojson);
                                } catch {
                                  previewVal = decoded.geojson;
                                }
                              }
                              setCellPreview({ columnName: col.name, value: previewVal });
                            }}
                          />
                        ) : canFollowFk ? (
                          <FkCell
                            value={shown ?? v}
                            target={`${fk.to_schema ? `${fk.to_schema}.` : ""}${fk.to_table}`}
                            onOpen={() => openFkTarget(fk, row)}
                            onEdit={canEdit ? startEdit : null}
                            onShowFull={() => setCellPreview({ columnName: col.name, value: v })}
                          />
                        ) : (
                          <ContextMenu>
                            <ContextMenuTrigger asChild>
                              <div
                                className="overflow-hidden text-ellipsis whitespace-nowrap px-3 py-1"
                                style={{ maxWidth: CELL_MAX_WIDTH }}
                              >
                                {shown === null ? (
                                  <span className="text-muted-foreground/60">NULL</span>
                                ) : (
                                  shown
                                )}
                              </div>
                            </ContextMenuTrigger>
                            <ContextMenuContent>
                              <ContextMenuItem
                                onSelect={() => setCellPreview({ columnName: col.name, value: v })}
                              >
                                <Eye className="size-3.5" />
                                Show full value
                              </ContextMenuItem>
                            </ContextMenuContent>
                          </ContextMenu>
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

      <CellPreviewDialog
        preview={cellPreview}
        onOpenChange={(o) => {
          if (!o) setCellPreview(null);
        }}
      />
    </div>
  );
}

function GeometryCell({
  value,
  onOpen,
  onShowFull,
}: {
  value: string;
  onOpen: () => void;
  onShowFull: () => void;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className="cursor-context-menu overflow-hidden text-ellipsis whitespace-nowrap px-3 py-1"
          style={{ maxWidth: CELL_MAX_WIDTH }}
        >
          {value}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={onOpen}>
          <MapIcon className="size-3.5" />
          Open in map
        </ContextMenuItem>
        <ContextMenuItem onSelect={onShowFull}>
          <Eye className="size-3.5" />
          Show full value
        </ContextMenuItem>
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
