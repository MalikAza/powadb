import { ipc } from "@/ipc";
import { type ByteaDisplayMode, parseByteaInput, stripHexPrefix } from "@/lib/bytea";
import { type BrowseTab, newQueryId } from "@/stores/tabs";
import type { Column, DbKind, SavedConnection } from "@/types";
import { maybeObjectId } from "@/utils/mongo";
import { quoteIdent, quoteTable } from "@/utils/sql";
import { type EditingState, parseMongoCellValue } from "../helpers";

export function useBrowseMutations({
  tab,
  conn,
  cols,
  rows,
  canEdit,
  editing,
  insertRow,
  selected,
  pkColIndexes,
  colIndexByName,
  byteaColMode,
  setEditing,
  setInsertRow,
  setSelected,
  setPendingDeleteRow,
  setPendingBulkDelete,
  setOpError,
  onRefresh,
}: {
  tab: BrowseTab;
  conn: SavedConnection;
  cols: Column[];
  rows: readonly (readonly unknown[])[];
  canEdit: boolean;
  editing: EditingState;
  insertRow: (string | null)[] | null;
  selected: Set<number>;
  pkColIndexes: number[] | null;
  colIndexByName: Map<string, number>;
  byteaColMode: Map<number, ByteaDisplayMode>;
  setEditing: (next: EditingState) => void;
  setInsertRow: (next: (string | null)[] | null) => void;
  setSelected: (next: Set<number>) => void;
  setPendingDeleteRow: (next: number | null) => void;
  setPendingBulkDelete: (next: boolean) => void;
  setOpError: (next: string | null) => void;
  onRefresh: () => void;
}) {
  async function runUpdate(setClause: string, firstParam: string | null) {
    if (!tab.pkCols || !editing) throw new Error("no primary key");
    const { row } = editing;
    const oldRow = rows[row];
    const wherePieces: string[] = [];
    const params: (string | null)[] = [firstParam];
    let pIdx = 2;
    for (const pkCol of tab.pkCols) {
      const idx = colIndexByName.get(pkCol);
      if (idx === undefined) throw new Error(`PK column ${pkCol} not in result`);
      const placeholder = conn.kind === "postgres" ? `$${pIdx}` : "?";
      wherePieces.push(pkEq(pkCol, placeholder, conn.kind));
      params.push(stringifyValue(oldRow[idx]));
      pIdx++;
    }
    const sql = `UPDATE ${quoteTable(tab.schema, tab.table, conn.kind)} SET ${setClause} WHERE ${wherePieces.join(" AND ")}`;
    await ipc.executeDml(conn.id, sql, params);
  }

  async function commitEdit() {
    if (!editing || !canEdit || !tab.pkCols) {
      setEditing(null);
      return;
    }
    const { row, col, value } = editing;
    const colDef = cols[col];
    const colName = colDef.name;
    const oldRow = rows[row];
    const original = oldRow[col];

    const byteaMode = byteaColMode.get(col);

    // Mongo branch — translate to UpdateMany with a single-doc match on the
    // PK columns. Parses `value` as JSON when it looks like JSON (objects,
    // arrays, numbers, bools, null) so the user can type structured updates;
    // otherwise treats it as a plain string.
    if (conn.kind === "mongo") {
      try {
        if (String(original ?? "") === value) {
          setEditing(null);
          return;
        }
        const parsed = parseMongoCellValue(value);
        const filter = buildMongoPkFilter(tab.pkCols, oldRow, colIndexByName);
        await ipc.runEngineQuery(conn.id, newQueryId(), {
          kind: "mongo",
          value: {
            op: "update_many",
            collection: tab.table,
            database: tab.schema,
            filter,
            update: { $set: { [colName]: parsed } },
          },
        });
        setEditing(null);
        setOpError(null);
        onRefresh();
      } catch (e) {
        setOpError(String(e));
      }
      return;
    }

    try {
      let paramValue: string | null = value;
      let setExpr: string;

      const ph1 = conn.kind === "postgres" ? "$1" : "?";

      if (byteaMode && byteaMode !== "hex" && conn.kind === "postgres") {
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

  async function commitInsert() {
    if (!insertRow) return;
    // Mongo branch: build a document from the non-empty cells. _id may be
    // omitted to let MongoDB auto-generate an ObjectId; if the user supplies
    // a 24-hex string for _id we wrap it as `{$oid}` so it lands as an
    // actual ObjectId rather than a string.
    if (conn.kind === "mongo") {
      try {
        const doc: Record<string, unknown> = {};
        cols.forEach((c, i) => {
          const v = insertRow[i];
          if (v === null || v === "") return;
          doc[c.name] = c.name === "_id" ? maybeObjectId(v) : parseMongoCellValue(v);
        });
        if (Object.keys(doc).length === 0) {
          throw new Error("All cells are empty — fill at least one column");
        }
        await ipc.runEngineQuery(conn.id, newQueryId(), {
          kind: "mongo",
          value: {
            op: "insert_one",
            collection: tab.table,
            database: tab.schema,
            document: doc,
          },
        });
        setInsertRow(null);
        setOpError(null);
        onRefresh();
      } catch (e) {
        setOpError(String(e));
      }
      return;
    }
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
    if (conn.kind === "mongo") {
      try {
        const rowIdxs = Array.from(selected).sort((a, b) => a - b);
        const filters: Record<string, unknown>[] = [];
        for (const ri of rowIdxs) {
          const row = rows[ri];
          if (!row) continue;
          filters.push(buildMongoPkFilter(tab.pkCols, row, colIndexByName));
        }
        if (filters.length === 0) return;
        const filter = filters.length === 1 ? filters[0] : { $or: filters };
        await ipc.runEngineQuery(conn.id, newQueryId(), {
          kind: "mongo",
          value: {
            op: "delete_many",
            collection: tab.table,
            database: tab.schema,
            filter,
          },
        });
        setSelected(new Set());
        setPendingBulkDelete(false);
        setOpError(null);
        onRefresh();
      } catch (e) {
        setOpError(String(e));
      }
      return;
    }
    try {
      const rowIdxs = Array.from(selected).sort((a, b) => a - b);
      const placeholder = (i: number) => (conn.kind === "postgres" ? `$${i}` : "?");
      const orPieces: string[] = [];
      const params: (string | null)[] = [];
      let pIdx = 1;
      for (const ri of rowIdxs) {
        const row = rows[ri];
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
    if (conn.kind === "mongo") {
      try {
        const oldRow = rows[rowIdx];
        const filter = buildMongoPkFilter(tab.pkCols, oldRow, colIndexByName);
        await ipc.runEngineQuery(conn.id, newQueryId(), {
          kind: "mongo",
          value: {
            op: "delete_many",
            collection: tab.table,
            database: tab.schema,
            filter,
          },
        });
        setPendingDeleteRow(null);
        setOpError(null);
        onRefresh();
      } catch (e) {
        setOpError(String(e));
      }
      return;
    }
    try {
      const oldRow = rows[rowIdx];
      const wherePieces: string[] = [];
      const params: (string | null)[] = [];
      let pIdx = 1;
      for (const pkCol of tab.pkCols) {
        const idx = colIndexByName.get(pkCol);
        if (idx === undefined) throw new Error(`PK column ${pkCol} not in result`);
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

  return { commitEdit, commitInsert, deleteSelectedRows, deleteRow };
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

/// Build a `{ field: ... }` Mongo match document from a row's PK columns.
/// `_id` values that look like 24-char hex strings are wrapped as `{$oid}`
/// so they decode as actual `ObjectId`s on the backend.
function buildMongoPkFilter(
  pkCols: string[],
  row: readonly unknown[],
  colIndexByName: Map<string, number>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const pkCol of pkCols) {
    const idx = colIndexByName.get(pkCol);
    if (idx === undefined) throw new Error(`PK column ${pkCol} not in result`);
    const v = row[idx];
    if (pkCol === "_id" && typeof v === "string") {
      out[pkCol] = maybeObjectId(v);
    } else {
      out[pkCol] = v;
    }
  }
  return out;
}
