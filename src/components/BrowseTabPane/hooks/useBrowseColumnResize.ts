import { useEffect, useMemo, useRef } from "react";
import { measureColumnWidths } from "@/components/ResultsGrid/measureColumnWidths";
import { useColumnResize } from "@/components/ResultsGrid/useColumnResize";
import { columnDisplayKey, useColumnDisplay } from "@/stores/columnDisplay";
import type { Column } from "@/types";

export function useBrowseColumnResize(
  connectionId: string,
  schema: string,
  table: string,
  cols: Column[],
  rows: readonly (readonly unknown[])[],
) {
  const columnWidthsStore = useColumnDisplay((s) => s.columnWidths);
  const setColumnWidth = useColumnDisplay((s) => s.setColumnWidth);
  const clearColumnWidth = useColumnDisplay((s) => s.clearColumnWidth);

  const autoColumnWidths = useMemo(() => measureColumnWidths(cols, rows), [cols, rows]);

  const initialColumnWidths = useMemo(() => {
    return cols.map((c, i) => {
      const k = columnDisplayKey(connectionId, schema, table, c.name);
      const stored = columnWidthsStore[k];
      return typeof stored === "number" ? stored : autoColumnWidths[i];
    });
  }, [cols, connectionId, schema, table, columnWidthsStore, autoColumnWidths]);

  const colRefs = useRef<(HTMLTableColElement | null)[]>([]);
  const liveWidthsRef = useRef<number[]>(initialColumnWidths);

  const {
    widths: columnWidths,
    startResize,
    resetWidth,
  } = useColumnResize(initialColumnWidths, {
    onCommit: (idx, width) => {
      const c = cols[idx];
      if (!c) return;
      setColumnWidth(columnDisplayKey(connectionId, schema, table, c.name), width);
    },
    onLiveResize: (idx, width) => {
      liveWidthsRef.current[idx] = width;
      const col = colRefs.current[idx];
      if (col) col.style.width = `${width}px`;
    },
    resetWidths: autoColumnWidths,
    onReset: (idx) => {
      const c = cols[idx];
      if (!c) return;
      clearColumnWidth(columnDisplayKey(connectionId, schema, table, c.name));
    },
  });

  useEffect(() => {
    liveWidthsRef.current = columnWidths.slice();
  }, [columnWidths]);

  return { colRefs, columnWidths, startResize, resetWidth };
}
