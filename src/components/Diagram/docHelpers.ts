import type { DbKind } from "@/types";
import type { DiagramColumn, DiagramDoc, DiagramEdge, DiagramTable } from "./types";
import { tableId as makeTableId, syncFkFlags } from "./types";

let seq = 0;
const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${++seq}`;

export function emptyDoc(engine: DbKind): DiagramDoc {
  return { version: 1, engine, tables: [], edges: [] };
}

function defaultSchemaFor(engine: DbKind): string {
  if (engine === "postgres") return "public";
  if (engine === "sqlite") return "main";
  return "";
}

export function ensureUniqueTableName(doc: DiagramDoc, base: string): string {
  if (!doc.tables.some((t) => t.name === base)) return base;
  let i = 2;
  while (doc.tables.some((t) => t.name === `${base}_${i}`)) i++;
  return `${base}_${i}`;
}

export function addTable(
  doc: DiagramDoc,
  init: { name: string; columns: Omit<DiagramColumn, "id" | "isFk">[] },
  position?: { x: number; y: number },
): { doc: DiagramDoc; tableId: string } {
  const schema = defaultSchemaFor(doc.engine);
  const name = ensureUniqueTableName(doc, init.name);
  const id = makeTableId(schema, name);
  const table: DiagramTable = {
    id,
    schema,
    name,
    position: position ?? nextPosition(doc),
    columns: init.columns.map((c) => ({
      id: `${id}.${c.name}`,
      name: c.name,
      dataType: c.dataType,
      nullable: c.nullable,
      isPk: c.isPk,
      isFk: false,
      defaultValue: c.defaultValue ?? null,
    })),
  };
  return { doc: { ...doc, tables: [...doc.tables, table] }, tableId: id };
}

function nextPosition(doc: DiagramDoc): { x: number; y: number } {
  if (doc.tables.length === 0) return { x: 60, y: 60 };
  const maxX = Math.max(...doc.tables.map((t) => t.position.x));
  const maxY = Math.max(...doc.tables.map((t) => t.position.y));
  return { x: maxX + 320, y: maxY };
}

export function removeTable(doc: DiagramDoc, tableId: string): DiagramDoc {
  return syncFkFlags({
    ...doc,
    tables: doc.tables.filter((t) => t.id !== tableId),
    edges: doc.edges.filter((e) => e.source !== tableId && e.target !== tableId),
  });
}

export function updateTablePosition(
  doc: DiagramDoc,
  tableId: string,
  position: { x: number; y: number },
): DiagramDoc {
  return {
    ...doc,
    tables: doc.tables.map((t) => (t.id === tableId ? { ...t, position } : t)),
  };
}

export function addEdge(
  doc: DiagramDoc,
  params: {
    source: string;
    target: string;
    sourceColumns: string[];
    targetColumns: string[];
    name?: string | null;
  },
): DiagramDoc {
  const edge: DiagramEdge = {
    id: uid("fk"),
    name: params.name ?? null,
    source: params.source,
    target: params.target,
    sourceColumns: params.sourceColumns,
    targetColumns: params.targetColumns,
    onUpdate: null,
    onDelete: null,
  };
  // Avoid exact duplicates (same source+target+columns).
  const dupe = doc.edges.some(
    (e) =>
      e.source === edge.source &&
      e.target === edge.target &&
      e.sourceColumns.join() === edge.sourceColumns.join() &&
      e.targetColumns.join() === edge.targetColumns.join(),
  );
  if (dupe) return doc;
  return syncFkFlags({ ...doc, edges: [...doc.edges, edge] });
}

export function removeEdge(doc: DiagramDoc, edgeId: string): DiagramDoc {
  return syncFkFlags({ ...doc, edges: doc.edges.filter((e) => e.id !== edgeId) });
}

/** Parse `tableId.columnName::source|target` back into its parts. */
export function parseHandleId(handle: string | null | undefined): {
  tableId: string;
  columnName: string;
} | null {
  if (!handle) return null;
  const [path] = handle.split("::");
  const lastDot = path.lastIndexOf(".");
  if (lastDot < 0) return null;
  return { tableId: path.slice(0, lastDot), columnName: path.slice(lastDot + 1) };
}
