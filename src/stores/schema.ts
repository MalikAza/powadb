import type { Completion } from "@codemirror/autocomplete";
import type { SQLNamespace } from "@codemirror/lang-sql";
import { create } from "zustand";
import type { SchemaMeta } from "../ipc";
import type { DbKind } from "../types";

type State = {
  byConnection: Record<string, SchemaMeta[]>;
};

type Actions = {
  set: (connectionId: string, schemas: SchemaMeta[]) => void;
  clear: (connectionId: string) => void;
};

export const useSchema = create<State & Actions>((set) => ({
  byConnection: {},
  set: (connectionId, schemas) =>
    set((s) => ({ byConnection: { ...s.byConnection, [connectionId]: schemas } })),
  clear: (connectionId) =>
    set((s) => {
      const { [connectionId]: _, ...rest } = s.byConnection;
      return { byConnection: rest };
    }),
}));

type Column = SchemaMeta["tables"][number]["columns"][number];

function colCompletion(c: Column): Completion {
  return {
    label: c.name,
    type: "property",
    detail: c.nullable ? c.data_type : `${c.data_type} not null`,
  };
}

function tableNamespace(t: SchemaMeta["tables"][number]): SQLNamespace {
  const children = t.columns.map(colCompletion);
  return {
    self: {
      label: t.name,
      type: t.kind === "view" ? "class" : "type",
      detail: t.kind === "view" ? "view" : undefined,
    },
    children,
  };
}

export function buildCmSchema(
  schemas: SchemaMeta[],
  kind: DbKind,
): { schema: SQLNamespace; defaultSchema?: string } {
  if (kind === "mysql") {
    const ns: Record<string, SQLNamespace> = {};
    for (const s of schemas) {
      for (const t of s.tables) {
        ns[t.name] = tableNamespace(t);
      }
    }
    return { schema: ns };
  }

  const ns: Record<string, SQLNamespace> = {};
  for (const s of schemas) {
    const tables: Record<string, SQLNamespace> = {};
    for (const t of s.tables) {
      tables[t.name] = tableNamespace(t);
    }
    ns[s.name] = {
      self: { label: s.name, type: "namespace", detail: "schema" },
      children: tables,
    };
  }
  return { schema: ns, defaultSchema: "public" };
}
