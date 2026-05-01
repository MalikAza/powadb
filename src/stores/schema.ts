import { create } from "zustand";
import type { SchemaMeta } from "../ipc";

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

export function buildCmSchema(
  schemas: SchemaMeta[],
  kind: "postgres" | "mysql",
): { schema: Record<string, string[]>; defaultSchema?: string } {
  const out: Record<string, string[]> = {};
  for (const s of schemas) {
    for (const t of s.tables) {
      const cols = t.columns.map((c) => c.name);
      if (kind === "postgres") {
        out[`${s.name}.${t.name}`] = cols;
        if (s.name === "public") out[t.name] = cols;
      } else {
        out[t.name] = cols;
      }
    }
  }
  return {
    schema: out,
    defaultSchema: kind === "postgres" ? "public" : undefined,
  };
}
