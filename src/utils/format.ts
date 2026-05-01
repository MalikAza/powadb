import type { QueryResult } from "../types";

export function toTsv(result: QueryResult): string {
  const header = result.columns.map((c) => c.name).join("\t");
  const rows = result.rows.map((r) =>
    r.map((v) => formatCell(v).replace(/\t/g, " ").replace(/\n/g, " ")).join("\t"),
  );
  return [header, ...rows].join("\n");
}

export function toCsv(result: QueryResult): string {
  const header = result.columns.map((c) => csvField(c.name)).join(",");
  const rows = result.rows.map((r) => r.map((v) => csvField(formatCell(v))).join(","));
  return [header, ...rows].join("\n");
}

export function toJson(result: QueryResult): string {
  const objs = result.rows.map((r) => {
    const obj: Record<string, unknown> = {};
    result.columns.forEach((c, i) => {
      obj[c.name] = r[i];
    });
    return obj;
  });
  return JSON.stringify(objs, null, 2);
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function csvField(s: string): string {
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
