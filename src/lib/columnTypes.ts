import type { Column, DbKind } from "../types";

const GEO_TYPES = new Set(["geometry", "geography"]);

export function isGeoColumn(kind: DbKind, c: Column): boolean {
  return kind === "postgres" && GEO_TYPES.has(c.type_name.toLowerCase());
}

// BYTEA is Postgres-only here — the MySQL `BLOB` family doesn't share the
// `\xHEX` wire shape and would need its own decoder.
export function isByteaColumn(kind: DbKind, c: Column): boolean {
  return kind === "postgres" && c.type_name.toUpperCase() === "BYTEA";
}
