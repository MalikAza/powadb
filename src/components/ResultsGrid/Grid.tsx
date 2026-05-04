import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import type { Column, QueryResult } from "../../types";

type RowShape = Record<string, unknown>;

type Props = {
  result: QueryResult;
};

export function ResultsGrid({ result }: Props) {
  const data = useMemo<RowShape[]>(
    () =>
      result.rows.map((r) => {
        const obj: RowShape = {};
        result.columns.forEach((c, i) => {
          obj[c.name] = r[i];
        });
        return obj;
      }),
    [result],
  );

  const columns = useMemo(() => {
    const helper = createColumnHelper<RowShape>();
    return result.columns.map((c: Column) =>
      helper.accessor((row) => row[c.name], {
        id: c.name,
        header: () => (
          <div>
            <div className="font-medium">{c.name}</div>
            <div className="text-[10px] font-normal text-muted-foreground">{c.type_name}</div>
          </div>
        ),
        cell: (info) => formatValue(info.getValue()),
      }),
    );
  }, [result]);

  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  const parentRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: table.getRowModel().rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 28,
    overscan: 12,
  });

  const [selected, setSelected] = useState<{ row: number; col: number }>({ row: 0, col: 0 });

  useEffect(() => {
    setSelected({ row: 0, col: 0 });
  }, [result]);

  const totalRows = result.rows.length;
  const totalCols = result.columns.length;

  function rawCellValue(row: number, col: number): unknown {
    return result.rows[row]?.[col];
  }

  function copyCell() {
    const v = rawCellValue(selected.row, selected.col);
    const text =
      v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    navigator.clipboard.writeText(text);
  }

  function move(dRow: number, dCol: number) {
    setSelected((s) => {
      const row = clamp(s.row + dRow, 0, Math.max(0, totalRows - 1));
      const col = clamp(s.col + dCol, 0, Math.max(0, totalCols - 1));
      if (dRow !== 0) rowVirtualizer.scrollToIndex(row, { align: "auto" });
      return { row, col };
    });
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (totalRows === 0) return;
    const meta = e.metaKey || e.ctrlKey;
    if (meta && e.key.toLowerCase() === "c") {
      e.preventDefault();
      copyCell();
      return;
    }
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        move(1, 0);
        break;
      case "ArrowUp":
        e.preventDefault();
        move(-1, 0);
        break;
      case "ArrowRight":
      case "Tab":
        e.preventDefault();
        move(0, e.shiftKey && e.key === "Tab" ? -1 : 1);
        break;
      case "ArrowLeft":
        e.preventDefault();
        move(0, -1);
        break;
      case "Home":
        e.preventDefault();
        if (meta) {
          setSelected({ row: 0, col: 0 });
          rowVirtualizer.scrollToIndex(0);
        } else {
          setSelected((s) => ({ ...s, col: 0 }));
        }
        break;
      case "End":
        e.preventDefault();
        if (meta) {
          setSelected({ row: totalRows - 1, col: totalCols - 1 });
          rowVirtualizer.scrollToIndex(totalRows - 1);
        } else {
          setSelected((s) => ({ ...s, col: totalCols - 1 }));
        }
        break;
      case "PageDown":
        e.preventDefault();
        move(20, 0);
        break;
      case "PageUp":
        e.preventDefault();
        move(-20, 0);
        break;
    }
  }

  return (
    <div
      ref={parentRef}
      role="grid"
      tabIndex={0}
      onKeyDown={onKeyDown}
      className="relative min-h-0 flex-1 overflow-auto rounded-md border border-border bg-card outline-none focus:ring-1 focus:ring-ring"
    >
      <div className="min-w-max">
        <div
          className="sticky top-0 z-10 grid border-b border-border bg-muted"
          style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(120px, max-content))` }}
        >
          {table.getHeaderGroups()[0]?.headers.map((header, colIdx) => (
            <div
              key={header.id}
              onClick={() => setSelected((s) => ({ ...s, col: colIdx }))}
              className={cn(
                "cursor-pointer whitespace-nowrap border-r border-border px-3 py-1.5 font-mono text-xs",
                selected.col === colIdx && "bg-primary/20",
              )}
            >
              {flexRender(header.column.columnDef.header, header.getContext())}
            </div>
          ))}
        </div>

        <div
          style={{
            height: rowVirtualizer.getTotalSize(),
            position: "relative",
          }}
        >
          {rowVirtualizer.getVirtualItems().map((virtualRow) => {
            const row = table.getRowModel().rows[virtualRow.index];
            const isSelectedRow = virtualRow.index === selected.row;
            return (
              <div
                key={row.id}
                className={cn(
                  "absolute left-0 top-0 grid w-full",
                  isSelectedRow
                    ? "bg-primary/10"
                    : virtualRow.index % 2
                      ? "bg-card"
                      : "bg-transparent",
                )}
                style={{
                  transform: `translateY(${virtualRow.start}px)`,
                  height: virtualRow.size,
                  gridTemplateColumns: `repeat(${columns.length}, minmax(120px, max-content))`,
                }}
              >
                {row.getVisibleCells().map((cell, colIdx) => {
                  const isSelected = isSelectedRow && colIdx === selected.col;
                  return (
                    <div
                      key={cell.id}
                      onClick={() => setSelected({ row: virtualRow.index, col: colIdx })}
                      className={cn(
                        "overflow-hidden text-ellipsis whitespace-nowrap border-r border-b border-border/50 px-3 py-1 font-mono text-xs",
                        isSelected &&
                          "bg-primary/30 outline outline-1 -outline-offset-1 outline-primary",
                      )}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function formatValue(v: unknown): React.ReactNode {
  if (v === null || v === undefined) {
    return <span className="text-muted-foreground/60">NULL</span>;
  }
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}
