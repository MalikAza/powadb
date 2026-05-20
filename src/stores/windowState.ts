import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";

type State = {
  width: number | null;
  height: number | null;
  x: number | null;
  y: number | null;
  maximized: boolean;
};

type Actions = {
  setBounds: (b: { width: number; height: number; x: number; y: number }) => void;
  setMaximized: (m: boolean) => void;
};

export const useWindowState = create<State & Actions>()(
  persist(
    (set) => ({
      width: null,
      height: null,
      x: null,
      y: null,
      maximized: false,
      setBounds: (b) => set(b),
      setMaximized: (maximized) => set({ maximized }),
    }),
    { name: "powadb-window-state" },
  ),
);

const SAVE_DEBOUNCE_MS = 200;

export function useRestoreAndPersistWindowState() {
  useEffect(() => {
    const win = getCurrentWindow();
    let unlistenResize: (() => void) | undefined;
    let unlistenMove: (() => void) | undefined;
    let saveTimer: number | undefined;
    let cancelled = false;

    async function setup() {
      const { width, height, x, y, maximized } = useWindowState.getState();

      if (width != null && height != null) {
        try {
          await win.setSize(new LogicalSize(width, height));
        } catch {}
      }
      if (x != null && y != null) {
        try {
          await win.setPosition(new LogicalPosition(x, y));
        } catch {}
      }
      if (maximized) {
        try {
          await win.maximize();
        } catch {}
      }

      if (cancelled) return;

      const scheduleSave = () => {
        if (saveTimer) window.clearTimeout(saveTimer);
        saveTimer = window.setTimeout(async () => {
          try {
            const isMax = await win.isMaximized();
            useWindowState.getState().setMaximized(isMax);
            if (isMax) return;
            const [factor, size, pos] = await Promise.all([
              win.scaleFactor(),
              win.outerSize(),
              win.outerPosition(),
            ]);
            const logicalSize = size.toLogical(factor);
            const logicalPos = pos.toLogical(factor);
            useWindowState.getState().setBounds({
              width: logicalSize.width,
              height: logicalSize.height,
              x: logicalPos.x,
              y: logicalPos.y,
            });
          } catch {}
        }, SAVE_DEBOUNCE_MS);
      };

      unlistenResize = await win.onResized(scheduleSave);
      unlistenMove = await win.onMoved(scheduleSave);
    }

    setup();

    return () => {
      cancelled = true;
      if (saveTimer) window.clearTimeout(saveTimer);
      unlistenResize?.();
      unlistenMove?.();
    };
  }, []);
}
