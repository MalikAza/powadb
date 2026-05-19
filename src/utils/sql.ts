import type { DbKind } from "../types";

export function quoteIdent(name: string, kind: DbKind): string {
  if (kind === "mysql") return `\`${name.replace(/`/g, "``")}\``;
  return `"${name.replace(/"/g, '""')}"`;
}

export function quoteTable(schema: string, table: string, kind: DbKind): string {
  // SQLite has no schemas (the "main" namespace is implicit) and MySQL ignores schema in our model.
  if (kind === "mysql" || kind === "sqlite") return quoteIdent(table, kind);
  return `${quoteIdent(schema, kind)}.${quoteIdent(table, kind)}`;
}

export function escapeStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export type CompareOp = ">" | "<" | ">=" | "<=" | "=" | "!=";

export type Filter =
  | { kind: "like"; value: string }
  | { kind: "compare"; op: CompareOp; value: string }
  | { kind: "between"; v1: string; v2: string }
  | { kind: "in"; values: string[] }
  | { kind: "is_null" }
  | { kind: "is_not_null" };

function renderScalar(v: string): string {
  const isNumeric = /^-?\d+(?:\.\d+)?$/.test(v);
  return isNumeric ? v : escapeStringLiteral(v);
}

export function isFilterComplete(filter: Filter): boolean {
  switch (filter.kind) {
    case "is_null":
    case "is_not_null":
      return true;
    case "compare":
    case "like":
      return filter.value.trim() !== "";
    case "between":
      return filter.v1.trim() !== "" && filter.v2.trim() !== "";
    case "in":
      return filter.values.length > 0;
  }
}

export function filterToSql(col: string, filter: Filter, kind: DbKind): string {
  const colQ = quoteIdent(col, kind);
  switch (filter.kind) {
    case "is_null":
      return `${colQ} IS NULL`;
    case "is_not_null":
      return `${colQ} IS NOT NULL`;
    case "compare":
      return `${colQ} ${filter.op} ${renderScalar(filter.value)}`;
    case "between":
      return `${colQ} BETWEEN ${renderScalar(filter.v1)} AND ${renderScalar(filter.v2)}`;
    case "in":
      return `${colQ} IN (${filter.values.map(renderScalar).join(", ")})`;
    case "like": {
      const escaped = escapeStringLiteral(`%${filter.value}%`);
      if (kind === "postgres") return `CAST(${colQ} AS TEXT) ILIKE ${escaped}`;
      if (kind === "sqlite") return `CAST(${colQ} AS TEXT) LIKE ${escaped}`;
      return `CAST(${colQ} AS CHAR) LIKE ${escaped}`;
    }
  }
}
