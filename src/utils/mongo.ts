import type { EngineResult } from "../ipc";
import type { Column, QueryResult } from "../types";
import type { Filter } from "./sql";

const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

/// Wrap a 24-char hex string in the extJSON `{$oid}` envelope so the Mongo
/// backend converts it back to a real `ObjectId` (otherwise filters on `_id`
/// silently compare hex strings against BSON ObjectIds and never match).
/// Non-hex strings pass through unwrapped.
export function maybeObjectId(v: string): unknown {
  if (OBJECT_ID_RE.test(v)) return { $oid: v };
  return v;
}

/// Best-effort scalar coercion for filter values: numbers parse as numbers,
/// booleans as booleans, `null`/`undefined` markers as null, hex IDs as
/// `{ $oid }`, everything else as the original string.
function coerceMongoScalar(field: string, raw: string): unknown {
  const v = raw.trim();
  if (v === "" || v === "null") return null;
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+$/.test(v)) return Number.parseInt(v, 10);
  if (/^-?\d+\.\d+$/.test(v)) return Number.parseFloat(v);
  if (field === "_id" && OBJECT_ID_RE.test(v)) return { $oid: v };
  return v;
}

/// Translate one Browse-panel `Filter` into a MongoDB filter expression for
/// the given field. Returns `null` for filters that don't have a meaningful
/// Mongo translation (incomplete inputs).
function filterToMongoClause(field: string, f: Filter): unknown | null {
  switch (f.kind) {
    case "is_null":
      return { $eq: null };
    case "is_not_null":
      return { $ne: null };
    case "compare": {
      const v = coerceMongoScalar(field, f.value);
      switch (f.op) {
        case "=":
          return v;
        case "!=":
          return { $ne: v };
        case ">":
          return { $gt: v };
        case "<":
          return { $lt: v };
        case ">=":
          return { $gte: v };
        case "<=":
          return { $lte: v };
      }
      return null;
    }
    case "between":
      return {
        $gte: coerceMongoScalar(field, f.v1),
        $lte: coerceMongoScalar(field, f.v2),
      };
    case "in":
      return { $in: f.values.map((v) => coerceMongoScalar(field, v)) };
    case "like":
      // SQL LIKE "%foo%" → case-insensitive regex containing the substring.
      // Escape regex metacharacters so the user's input is treated literally.
      return { $regex: f.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" };
  }
}

type FilterTabShape = { filters: Record<string, Filter> };

/// Build a MongoDB filter document from the Browse panel's `tab.filters`.
/// Filters AND together at the top level; empty / incomplete filters drop.
export function mongoFiltersFromTab(tab: FilterTabShape): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [field, f] of Object.entries(tab.filters)) {
    const clause = filterToMongoClause(field, f);
    if (clause !== null) out[field] = clause;
  }
  return out;
}

type SortTabShape = { sortCol: string | null; sortDir: "asc" | "desc" };

/// Build a MongoDB sort document (`{ field: 1 | -1 }`) from the Browse
/// panel's sort state. Returns `undefined` when no sort is active so the
/// driver doesn't pay the cost of an empty sort stage.
export function mongoSortFromTab(tab: SortTabShape): Record<string, 1 | -1> | undefined {
  if (!tab.sortCol) return undefined;
  return { [tab.sortCol]: tab.sortDir === "asc" ? 1 : -1 };
}

/// Convert MongoDB documents into the tabular `QueryResult` shape the
/// existing results grid renders. Columns are the union of top-level field
/// names across the batch (`_id` always first), with the type label inferred
/// from the actual values seen — `string`, `int`, `double`, `bool`, `array`,
/// `object`, 24-char-hex strings in `_id` are flagged as `ObjectId`. Mixed
/// types within a column (which Mongo allows) come out joined with " | ".
/// Documents missing a given field produce `null` for that cell.
export function mongoDocumentsToQueryResult(
  docs: Record<string, unknown>[],
  elapsedMs: number,
): QueryResult {
  const fieldTypes = new Map<string, Set<string>>();
  for (const d of docs) {
    if (!d || typeof d !== "object") continue;
    for (const [k, v] of Object.entries(d)) {
      if (v === null || v === undefined) continue;
      const t = inferMongoType(k, v);
      const types = fieldTypes.get(k) ?? new Set<string>();
      types.add(t);
      fieldTypes.set(k, types);
    }
  }
  if (!fieldTypes.has("_id")) fieldTypes.set("_id", new Set(["ObjectId"]));
  const names = ["_id", ...[...fieldTypes.keys()].filter((n) => n !== "_id").sort()];
  const columns: Column[] = names.map((name) => {
    const types = fieldTypes.get(name);
    const type_name = !types || types.size === 0 ? "null" : [...types].sort().join(" | ");
    return { name, type_name };
  });
  const rows = docs.map((d) => names.map((n) => (d?.[n] ?? null) as unknown));
  return { columns, rows, elapsed_ms: elapsedMs };
}

function inferMongoType(field: string, v: unknown): string {
  if (typeof v === "string") {
    if (field === "_id" && OBJECT_ID_RE.test(v)) return "ObjectId";
    return "string";
  }
  if (typeof v === "number") return Number.isInteger(v) ? "int" : "double";
  if (typeof v === "boolean") return "bool";
  if (Array.isArray(v)) return "array";
  if (typeof v === "object") return "object";
  return typeof v;
}

/// Adapter for the engine-agnostic result shape: render any `EngineResult`
/// as a `QueryResult` so the existing grid can display it. Documents go
/// through `mongoDocumentsToQueryResult`; `Affected` becomes a one-row
/// summary; `Tabular` is the inner SQL result unchanged.
export function engineResultToQueryResult(er: EngineResult): QueryResult {
  if (er.kind === "tabular") {
    return {
      columns: er.columns as Column[],
      rows: er.rows as unknown[][],
      elapsed_ms: er.elapsed_ms,
    };
  }
  if (er.kind === "documents") {
    return mongoDocumentsToQueryResult(er.docs as Record<string, unknown>[], er.elapsed_ms);
  }
  // Affected: synthesize a 1×1 "rows affected" summary so the grid has
  // something meaningful to show after a write.
  return {
    columns: [{ name: "rows_affected", type_name: "int" }],
    rows: [[er.rows]],
    elapsed_ms: er.elapsed_ms,
  };
}
