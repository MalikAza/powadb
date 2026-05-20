import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ByteaDisplayMode } from "@/lib/bytea";

// Per-column user preferences for the browse grid:
// - `byteaModes`: how BYTEA cells render (hex/ULID/UUID). Default is "hex".
// - `columnWidths`: user-resized column width in pixels. Absent means use the
//   auto-computed width from the result's content.
// Both maps are keyed by `${connectionId}:${schema}:${table}:${column}`.

type State = {
  byteaModes: Record<string, ByteaDisplayMode>;
  columnWidths: Record<string, number>;
};

type Actions = {
  setByteaMode: (key: string, mode: ByteaDisplayMode) => void;
  setColumnWidth: (key: string, width: number) => void;
  clearColumnWidth: (key: string) => void;
};

export const columnDisplayKey = (
  connectionId: string,
  schema: string,
  table: string,
  column: string,
) => `${connectionId}:${schema}:${table}:${column}`;

export const useColumnDisplay = create<State & Actions>()(
  persist(
    (set) => ({
      byteaModes: {},
      columnWidths: {},
      setByteaMode: (key, mode) => set((s) => ({ byteaModes: { ...s.byteaModes, [key]: mode } })),
      setColumnWidth: (key, width) =>
        set((s) => ({ columnWidths: { ...s.columnWidths, [key]: width } })),
      clearColumnWidth: (key) =>
        set((s) => {
          if (!(key in s.columnWidths)) return s;
          const next = { ...s.columnWidths };
          delete next[key];
          return { columnWidths: next };
        }),
    }),
    { name: "powadb-column-display" },
  ),
);
