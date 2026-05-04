import { create } from "zustand";

export type SidebarPane = "schema" | "history" | "snippets";

type State = {
  pane: SidebarPane;
  openSchemas: Record<string, boolean>;
  openTables: Record<string, boolean>;
  exportDialog: { connectionId: string } | null;
  importDialog: { connectionId: string } | null;
};

type Actions = {
  setPane: (pane: SidebarPane) => void;
  toggleSchema: (schema: string) => void;
  setSchemaOpen: (schema: string, open: boolean) => void;
  toggleTable: (schema: string, table: string) => void;
  setTableOpen: (schema: string, table: string, open: boolean) => void;
  revealTable: (schema: string, table: string) => void;
  openExportDialog: (connectionId: string) => void;
  closeExportDialog: () => void;
  openImportDialog: (connectionId: string) => void;
  closeImportDialog: () => void;
};

const tableKey = (schema: string, table: string) => `${schema}.${table}`;

export const useUi = create<State & Actions>((set) => ({
  pane: "schema",
  openSchemas: {},
  openTables: {},
  exportDialog: null,
  importDialog: null,

  setPane: (pane) => set({ pane }),

  openExportDialog: (connectionId) => set({ exportDialog: { connectionId } }),
  closeExportDialog: () => set({ exportDialog: null }),
  openImportDialog: (connectionId) => set({ importDialog: { connectionId } }),
  closeImportDialog: () => set({ importDialog: null }),

  toggleSchema: (schema) =>
    set((s) => ({ openSchemas: { ...s.openSchemas, [schema]: !s.openSchemas[schema] } })),

  setSchemaOpen: (schema, open) =>
    set((s) => ({ openSchemas: { ...s.openSchemas, [schema]: open } })),

  toggleTable: (schema, table) =>
    set((s) => {
      const k = tableKey(schema, table);
      return { openTables: { ...s.openTables, [k]: !s.openTables[k] } };
    }),

  setTableOpen: (schema, table, open) =>
    set((s) => ({ openTables: { ...s.openTables, [tableKey(schema, table)]: open } })),

  revealTable: (schema, table) =>
    set((s) => ({
      pane: "schema",
      openSchemas: { ...s.openSchemas, [schema]: true },
      openTables: { ...s.openTables, [tableKey(schema, table)]: true },
    })),
}));
