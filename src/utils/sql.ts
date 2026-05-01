import type { DbKind } from "../types";

export function quoteIdent(name: string, kind: DbKind): string {
  if (kind === "mysql") return "`" + name.replace(/`/g, "``") + "`";
  return '"' + name.replace(/"/g, '""') + '"';
}

export function quoteTable(schema: string, table: string, kind: DbKind): string {
  if (kind === "mysql") return quoteIdent(table, kind);
  return `${quoteIdent(schema, kind)}.${quoteIdent(table, kind)}`;
}

export function escapeStringLiteral(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'";
}

export type Filter =
  | { kind: "like"; value: string }
  | { kind: "compare"; op: ">" | "<" | ">=" | "<=" | "=" | "!="; value: string }
  | { kind: "is_null" }
  | { kind: "is_not_null" };

export function parseFilter(input: string): Filter | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  if (lower === "null" || lower === "is null") return { kind: "is_null" };
  if (lower === "not null" || lower === "is not null") return { kind: "is_not_null" };

  const ops = [">=", "<=", "!=", ">", "<", "="] as const;
  for (const op of ops) {
    if (trimmed.startsWith(op)) {
      return { kind: "compare", op, value: trimmed.slice(op.length).trim() };
    }
  }
  return { kind: "like", value: trimmed };
}

export function filterToSql(col: string, filter: Filter, kind: DbKind): string {
  const colQ = quoteIdent(col, kind);
  switch (filter.kind) {
    case "is_null":
      return `${colQ} IS NULL`;
    case "is_not_null":
      return `${colQ} IS NOT NULL`;
    case "compare": {
      const v = filter.value;
      const isNumeric = /^-?\d+(?:\.\d+)?$/.test(v);
      const valueSql = isNumeric ? v : escapeStringLiteral(v);
      return `${colQ} ${filter.op} ${valueSql}`;
    }
    case "like": {
      const escaped = escapeStringLiteral(`%${filter.value}%`);
      if (kind === "postgres") return `CAST(${colQ} AS TEXT) ILIKE ${escaped}`;
      return `CAST(${colQ} AS CHAR) LIKE ${escaped}`;
    }
  }
}
