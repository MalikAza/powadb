import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ByteaDisplayMode } from "@/lib/bytea";

// Per-column user preference for how BYTEA cells render in the browse grid.
// Keyed by `${connectionId}:${schema}:${table}:${column}`. Default is "hex"
// (the on-the-wire representation); users opt into ULID/UUID per column.

type State = {
  byteaModes: Record<string, ByteaDisplayMode>;
};

type Actions = {
  setByteaMode: (key: string, mode: ByteaDisplayMode) => void;
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
      setByteaMode: (key, mode) => set((s) => ({ byteaModes: { ...s.byteaModes, [key]: mode } })),
    }),
    { name: "powadb-column-display" },
  ),
);
