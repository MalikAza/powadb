import type { EngineResult } from "../ipc";
import type { Column, QueryResult } from "../types";

const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

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
