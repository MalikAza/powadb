import type { DiagFk, DiagramIntrospection, DiagTable } from "@/ipc";

export type DiagramColumn = {
  id: string;
  name: string;
  dataType: string;
  nullable: boolean;
  isPk: boolean;
  isFk: boolean;
};

export type DiagramTable = {
  id: string;
  schema: string;
  name: string;
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

function tableFromIntro(t: DiagTable, fks: DiagFk[]): DiagramTable {
  const id = tableId(t.schema, t.name);
  return {
    id,
    schema: t.schema,
    name: t.name,
    columns: t.columns.map((c) => ({
      id: `${id}.${c.name}`,
      name: c.name,
      dataType: c.data_type,
      nullable: c.nullable,
      isPk: c.is_pk,
      isFk: isFkColumn(fks, t.schema, t.name, c.name),
    })),
    position: { x: 0, y: 0 },
  };
}

export function introspectionToDoc(intro: DiagramIntrospection): DiagramDoc {
  const tables = intro.tables.map((t) => tableFromIntro(t, intro.foreign_keys));
  const edges: DiagramEdge[] = intro.foreign_keys
    .map((fk) => {
      const source = tableId(fk.from_schema, fk.from_table);
      const target = tableId(fk.to_schema, fk.to_table);
      // Drop edges whose target isn't in the doc (cross-schema FKs outside scope).
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
  return { version: 1, tables, edges };
}
