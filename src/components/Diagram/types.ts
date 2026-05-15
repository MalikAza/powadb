import type { DiagColumn, DiagFk, DiagramIntrospection, DiagTable } from "@/ipc";
import type { DbKind } from "@/types";

export type DiagramColumn = {
  id: string;
  name: string;
  /** Name as it exists in the live DB. Undefined for columns the user added
   * since the last successful Apply. Set on introspect and re-set after Apply.
   * If `originalName !== name`, the diff engine emits a RENAME. */
  originalName?: string;
  dataType: string;
  nullable: boolean;
  isPk: boolean;
  isFk: boolean;
  defaultValue: string | null;
};

export type DiagramTable = {
  id: string;
  schema: string;
  name: string;
  /** Same contract as DiagramColumn.originalName but for tables. */
  originalName?: string;
  columns: DiagramColumn[];
  position: { x: number; y: number };
};

export type DiagramEdge = {
  id: string;
  name: string | null;
  source: string;
  target: string;
  sourceColumns: string[];
  targetColumns: string[];
  onUpdate: string | null;
  onDelete: string | null;
};

export type DiagramDoc = {
  version: 1;
  engine: DbKind;
  tables: DiagramTable[];
  edges: DiagramEdge[];
};

export function tableId(schema: string, name: string): string {
  return `${schema}.${name}`;
}

function isFkColumn(fks: DiagFk[], schema: string, table: string, column: string): boolean {
  return fks.some(
    (fk) =>
      fk.from_schema === schema && fk.from_table === table && fk.from_columns.includes(column),
  );
}

/**
 * Render a precise type string from introspection metadata so the doc carries
 * something usable for DDL generation (e.g. `varchar(255)` not just `varchar`).
 */
export function renderDataType(c: DiagColumn): string {
  const base = c.data_type;
  if (base === "character varying") {
    return c.char_max_len != null ? `varchar(${c.char_max_len})` : "varchar";
  }
  if (base === "character") {
    return c.char_max_len != null ? `char(${c.char_max_len})` : "char";
  }
  if (base === "numeric" || base === "decimal") {
    if (c.numeric_precision != null && c.numeric_scale != null) {
      return `${base}(${c.numeric_precision},${c.numeric_scale})`;
    }
    if (c.numeric_precision != null) return `${base}(${c.numeric_precision})`;
  }
  return base;
}

function tableFromIntro(t: DiagTable, fks: DiagFk[]): DiagramTable {
  const id = tableId(t.schema, t.name);
  return {
    id,
    schema: t.schema,
    name: t.name,
    originalName: t.name,
    columns: t.columns.map((c) => ({
      id: `${id}.${c.name}`,
      name: c.name,
      originalName: c.name,
      dataType: renderDataType(c),
      nullable: c.nullable,
      isPk: c.is_pk,
      isFk: isFkColumn(fks, t.schema, t.name, c.name),
      defaultValue: c.default,
    })),
    position: { x: 0, y: 0 },
  };
}

export function introspectionToDoc(intro: DiagramIntrospection, engine: DbKind): DiagramDoc {
  const tables = intro.tables.map((t) => tableFromIntro(t, intro.foreign_keys));
  const edges: DiagramEdge[] = intro.foreign_keys
    .map((fk) => {
      const source = tableId(fk.from_schema, fk.from_table);
      const target = tableId(fk.to_schema, fk.to_table);
      if (!tables.some((t) => t.id === source)) return null;
      if (!tables.some((t) => t.id === target)) return null;
      return {
        id: fk.id,
        name: fk.name,
        source,
        target,
        sourceColumns: fk.from_columns,
        targetColumns: fk.to_columns,
        onUpdate: fk.on_update,
        onDelete: fk.on_delete,
      } satisfies DiagramEdge;
    })
    .filter((e): e is DiagramEdge => e !== null);
  return { version: 1, engine, tables, edges };
}

/**
 * Recompute every column's `isFk` flag from the edge list. Call after the user
 * adds/removes an edge so the column row icons stay in sync.
 */
export function syncFkFlags(doc: DiagramDoc): DiagramDoc {
  const fkCols = new Set<string>();
  for (const e of doc.edges) {
    for (const c of e.sourceColumns) fkCols.add(`${e.source}.${c}`);
  }
  return {
    ...doc,
    tables: doc.tables.map((t) => ({
      ...t,
      columns: t.columns.map((c) => ({ ...c, isFk: fkCols.has(c.id) })),
    })),
  };
}
