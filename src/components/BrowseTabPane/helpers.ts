import type { CellPreview } from "@/components/CellPreviewDialog";
import type { GeometryMapInput } from "@/components/GeometryMap/GeometryMapDialog";
import type { DecodedGeometry, DiagFk } from "@/ipc";
import { type ByteaDisplayMode, formatBytea, parseByteaInput } from "@/lib/bytea";
import { isByteaColumn } from "@/lib/columnTypes";
import { columnDisplayKey } from "@/stores/columnDisplay";
import type { BrowseTab } from "@/stores/tabs";
import type { Column, DbKind, SavedConnection } from "@/types";
import { type Filter, filterToSql, isFilterComplete, quoteIdent } from "@/utils/sql";

export type GeomDecoded = DecodedGeometry & { coordsJson: string };

export type EditOps = {
  editing: { row: number; col: number; value: string } | null;
  insertRow: (string | null)[] | null;
  pendingDeleteRow: number | null;
  pendingBulkDelete: boolean;
  opError: string | null;
};

export const INITIAL_EDIT_OPS: EditOps = {
  editing: null,
  insertRow: null,
  pendingDeleteRow: null,
  pendingBulkDelete: false,
  opError: null,
};

export type Dialogs = { map: GeometryMapInput | null; cellPreview: CellPreview | null };

export function geomKey(row: number, col: number): string {
  return `${row}:${col}`;
}

export function buildRowData(
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

export function formatPkValue(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "string") return `'${v.replace(/'/g, "''")}'`;
  return String(v);
}

export function pkLabelFor(
  pkColIndexes: number[] | null,
  cols: Column[],
  row: unknown[],
): string | null {
  if (!pkColIndexes || pkColIndexes.length === 0) return null;
  return pkColIndexes.map((idx) => `${cols[idx].name} = ${formatPkValue(row[idx])}`).join(", ");
}

export function buildWhereClause(
  tab: BrowseTab,
  conn: SavedConnection,
  cols: Column[],
  byteaModes: Record<string, ByteaDisplayMode>,
): string {
  const colsByName = new Map(cols.map((c) => [c.name, c]));
  const parts: string[] = [];
  for (const [colName, filter] of Object.entries(tab.filters)) {
    const c = colsByName.get(colName);
    const isBytea = c ? isByteaColumn(conn.kind, c) : false;
    const byteaMode = isBytea
      ? (byteaModes[columnDisplayKey(conn.id, tab.schema, tab.table, colName)] ?? "hex")
      : null;
    if (byteaMode && byteaMode !== "hex") {
      const sql = byteaFilterToSql(colName, filter, conn.kind, byteaMode);
      if (sql) parts.push(sql);
      continue;
    }
    if (isFilterComplete(filter)) parts.push(filterToSql(colName, filter, conn.kind));
  }
  if (parts.length === 0) return "";
  return ` WHERE ${parts.join(" AND ")}`;
}

// BYTEA columns rendered as ULID/UUID need their filter values decoded back to
// hex before going into SQL — otherwise the user typing a ULID would be compared
// as a text string against the raw bytes and never match.
export function byteaFilterToSql(
  colName: string,
  filter: Filter,
  kind: DbKind,
  mode: ByteaDisplayMode,
): string | null {
  if (kind !== "postgres") return null;
  const colQ = quoteIdent(colName, kind);
  const toLit = (v: string): string | null => {
    const hex = parseByteaInput(v, mode);
    return hex === null ? null : `'\\x${hex}'::bytea`;
  };
  switch (filter.kind) {
    case "is_null":
      return `${colQ} IS NULL`;
    case "is_not_null":
      return `${colQ} IS NOT NULL`;
    case "compare": {
      const lit = toLit(filter.value);
      return lit ? `${colQ} ${filter.op} ${lit}` : null;
    }
    case "like": {
      // ULID/UUID substrings don't map to BYTEA substrings — require a fully
      // valid value and treat "contains" as equality.
      const lit = toLit(filter.value);
      return lit ? `${colQ} = ${lit}` : null;
    }
    case "between": {
      const a = toLit(filter.v1);
      const b = toLit(filter.v2);
      return a && b ? `${colQ} BETWEEN ${a} AND ${b}` : null;
    }
    case "in": {
      const lits: string[] = [];
      for (const v of filter.values) {
        const lit = toLit(v);
        if (!lit) return null;
        lits.push(lit);
      }
      if (lits.length === 0) return null;
      return `${colQ} IN (${lits.join(", ")})`;
    }
  }
}

export function cellDisplayString(
  raw: unknown,
  decoded: GeomDecoded | undefined,
  mode: ByteaDisplayMode | undefined,
): string | null {
  if (raw === null || raw === undefined) return null;
  if (decoded) return decoded.coordsJson;
  if (mode && mode !== "hex" && typeof raw === "string") {
    const formatted = formatBytea(raw, mode);
    if (formatted !== null) return formatted;
  }
  if (typeof raw === "object") return JSON.stringify(raw);
  return String(raw);
}

export function buildFkFilters(
  fk: DiagFk,
  row: readonly unknown[],
  cols: Column[],
): Record<string, Filter> | null {
  const filters: Record<string, Filter> = {};
  fk.from_columns.forEach((fromCol, i) => {
    const idx = cols.findIndex((c) => c.name === fromCol);
    if (idx === -1) return;
    const v = row[idx];
    if (v === null || v === undefined) return;
    const toCol = fk.to_columns[i];
    if (!toCol) return;
    filters[toCol] = {
      kind: "compare",
      op: "=",
      value: typeof v === "object" ? JSON.stringify(v) : String(v),
    };
  });
  return Object.keys(filters).length > 0 ? filters : null;
}

/// Parse a Browse-cell text input into a Mongo-friendly value. Tries JSON
/// first (so the user can type `42`, `true`, `null`, `{ "$oid": "..." }`,
/// `["a","b"]`, etc.); falls back to the raw string. Empty input → `null`.
export function parseMongoCellValue(raw: string): unknown {
  const v = raw;
  if (v === "") return null;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}
