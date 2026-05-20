import { useCallback, useEffect, useRef, useState } from "react";

export const RESIZE_MIN_PX = 60;
export const RESIZE_MAX_PX = 1200;

type Options = {
  /** Called on pointerup with the final width. Used by callers that persist. */
  onCommit?: (colIdx: number, width: number) => void;
  /**
   * If provided, fires on every pointer move with the new width. State updates
   * are deferred until pointerup, so the caller can mutate the DOM imperatively
   * during the drag and avoid re-rendering the whole grid on every frame. This
   * is the only sane mode for non-virtualized grids (e.g. browse-data).
   */
  onLiveResize?: (colIdx: number, width: number) => void;
  /**
   * Optional override for the per-column reset target. When `resetWidth` is
   * invoked (double-click), the hook uses `resetWidths[idx]` instead of
   * `initialWidths[idx]`. Useful when `initialWidths` already incorporates
   * user-persisted overrides and you want reset to fall back to a pristine
   * auto-measured default.
   */
  resetWidths?: number[];
  /**
   * If provided, called by `resetWidth` instead of `onCommit`. Lets the caller
   * distinguish a true reset (e.g. clear a persisted width) from a drag commit.
   */
  onReset?: (colIdx: number, width: number) => void;
};

/**
 * Manage a list of column widths with a pointer-driven resize interaction.
 * Both `ResultsGrid` and `BrowseTabPane` consume this; persistence is the
 * caller's responsibility (via `onCommit`).
 *
 * `initialWidths` is treated as the "default" widths and re-syncs the local
 * state whenever its identity changes — callers must memoize it so a new query
 * result / new table swap resets widths.
 */
export function useColumnResize(initialWidths: number[], options: Options = {}) {
  const [widths, setWidthsState] = useState<number[]>(initialWidths);
  const widthsRef = useRef<number[]>(initialWidths);
  const initialRef = useRef<number[]>(initialWidths);

  // Mirror the canonical widths array to a ref so `startResize` can read the
  // current value synchronously (state updates are async in React 18).
  const setWidths = useCallback((next: number[] | ((prev: number[]) => number[])) => {
    const value = typeof next === "function" ? next(widthsRef.current) : next;
    widthsRef.current = value;
    setWidthsState(value);
  }, []);

  useEffect(() => {
    initialRef.current = initialWidths;
    widthsRef.current = initialWidths;
    setWidthsState(initialWidths);
  }, [initialWidths]);

  const onCommitRef = useRef(options.onCommit);
  const onLiveResizeRef = useRef(options.onLiveResize);
  const onResetRef = useRef(options.onReset);
  const resetWidthsRef = useRef(options.resetWidths);
  useEffect(() => {
    onCommitRef.current = options.onCommit;
    onLiveResizeRef.current = options.onLiveResize;
    onResetRef.current = options.onReset;
    resetWidthsRef.current = options.resetWidths;
  }, [options.onCommit, options.onLiveResize, options.onReset, options.resetWidths]);

  const startResize = useCallback(
    (colIdx: number, e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const target = e.currentTarget as HTMLElement;
      try {
        target.setPointerCapture(e.pointerId);
      } catch {
        // Some browsers throw if capture is already held; ignore.
      }

      const startX = e.clientX;
      const startW = widthsRef.current[colIdx] ?? initialRef.current[colIdx] ?? RESIZE_MIN_PX;
      let latestWidth = startW;

      document.body.classList.add("col-resizing");

      const onMove = (ev: PointerEvent) => {
        const dx = ev.clientX - startX;
        const next = Math.min(RESIZE_MAX_PX, Math.max(RESIZE_MIN_PX, startW + dx));
        if (next === latestWidth) return;
        latestWidth = next;
        if (onLiveResizeRef.current) {
          // Imperative mode: caller updates the DOM directly; skip React state
          // so we don't re-render hundreds of rows per frame.
          onLiveResizeRef.current(colIdx, next);
          return;
        }
        setWidths((prev) => {
          if (prev[colIdx] === next) return prev;
          const out = prev.slice();
          out[colIdx] = next;
          return out;
        });
      };

      const onUp = () => {
        target.removeEventListener("pointermove", onMove);
        target.removeEventListener("pointerup", onUp);
        target.removeEventListener("pointercancel", onUp);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        document.body.classList.remove("col-resizing");
        if (onLiveResizeRef.current && latestWidth !== startW) {
          // Commit the dragged width to React state once, on release.
          setWidths((prev) => {
            if (prev[colIdx] === latestWidth) return prev;
            const out = prev.slice();
            out[colIdx] = latestWidth;
            return out;
          });
        }
        onCommitRef.current?.(colIdx, latestWidth);
      };

      // Listen on both the captured element and the window so we don't miss
      // events whether the browser routes via pointer capture or not.
      target.addEventListener("pointermove", onMove);
      target.addEventListener("pointerup", onUp);
      target.addEventListener("pointercancel", onUp);
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [setWidths],
  );

  const resetWidth = useCallback(
    (colIdx: number) => {
      const targets = resetWidthsRef.current ?? initialRef.current;
      const def = targets[colIdx];
      if (def === undefined) return;
      const applyState = () => {
        setWidths((prev) => {
          if (prev[colIdx] === def) return prev;
          const out = prev.slice();
          out[colIdx] = def;
          return out;
        });
        if (onResetRef.current) onResetRef.current(colIdx, def);
        else onCommitRef.current?.(colIdx, def);
      };
      if (onLiveResizeRef.current) {
        // Paint the imperative width change first, then defer the React state
        // update so the user sees the column snap before a full re-render of
        // an unvirtualized table blocks the main thread.
        onLiveResizeRef.current(colIdx, def);
        setTimeout(applyState, 0);
      } else {
        applyState();
      }
    },
    [setWidths],
  );

  return { widths, startResize, resetWidth };
}
