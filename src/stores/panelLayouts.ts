import type { Layout } from "react-resizable-panels";
import { create } from "zustand";
import { persist } from "zustand/middleware";

type State = {
  layouts: Record<string, Layout>;
};

type Actions = {
  setLayout: (id: string, layout: Layout) => void;
};

export const usePanelLayouts = create<State & Actions>()(
  persist(
    (set) => ({
      layouts: {},
      setLayout: (id, layout) => set((s) => ({ layouts: { ...s.layouts, [id]: layout } })),
    }),
    { name: "powadb-panel-layouts" },
  ),
);
