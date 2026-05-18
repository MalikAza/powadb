import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Eye, Map as MapIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import type { Column, DbKind, QueryResult } from "../../types";
import { type CellPreview, CellPreviewDialog } from "../CellPreviewDialog";
import { GeometryMapDialog, type GeometryMapInput } from "../GeometryMap";

type RowShape = Record<string, unknown>;

type Props = {
  result: QueryResult;
  connectionId: string;
  kind: DbKind;
};

const GEO_TYPES = new Set(["geometry", "geography"]);

function isGeoColumn(kind: DbKind, c: Column): boolean {
  return kind === "postgres" && GEO_TYPES.has(c.type_name.toLowerCase());
}

function buildRowData(
  columns: Column[],
  row: readonly unknown[],
  excluded: Set<number>,
): Array<[string, unknown]> {
  const out: Array<[string, unknown]> = [];
  columns.forEach((c, i) => {
    if (excluded.has(i)) return;
    out.push([c.name, row[i]]);
  });
  return out;
}

function buildShowAllInput(
  result: QueryResult,
  column: Column,
  columnIdx: number,
): GeometryMapInput | null {
  const excluded = new Set([columnIdx]);
  const values: Array<{
    rowIndex: number;
    pkLabel: string | null;
    ewkbHex: string;
    rowData: Array<[string, unknown]>;
  }> = [];
  result.rows.forEach((row, rowIndex) => {
    const v = row[columnIdx];
    if (typeof v === "string" && v !== "") {
      values.push({
        rowIndex,
        pkLabel: null,
        ewkbHex: v,
        rowData: buildRowData(result.columns, row, excluded),
      });
    }
  });
  if (values.length === 0) return null;
  return {
    kind: "multi",
    title: `${column.name} · all rows`,
    columns: [{ name: column.name, values }],
  };
}

function countNonNull(result: QueryResult, columnIdx: number): number {
  let n = 0;
  for (const row of result.rows) {
    const v = row[columnIdx];
    if (typeof v === "string" && v !== "") n++;
  }
  return n;
}

export function ResultsGrid({ result, connectionId, kind }: Props) {
  const [mapDialog, setMapDialog] = useState<GeometryMapInput | null>(null);
  const [cellPreview, setCellPreview] = useState<CellPreview | null>(null);
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

  // Each header/row was its own grid using `minmax(120px, max-content)`, so columns
  // sized themselves per-row based on that row's content — causing misalignment.
  // Compute one width per column from the longest stringified value and apply the
  // same `gridTemplateColumns` to the header and every row.
  const gridTemplateColumns = useMemo(() => {
    const CHAR_PX = 7;
    const PADDING_PX = 28;
    const MIN_PX = 120;
    const MAX_PX = 280;
    const widths = result.columns.map((c, colIdx) => {
      let maxChars = Math.max(c.name.length, c.type_name.length);
      const cap = Math.ceil((MAX_PX - PADDING_PX) / CHAR_PX);
      for (const row of result.rows) {
        const v = row[colIdx];
        const s =
          v === null || v === undefined
            ? "NULL"
            : typeof v === "object"
              ? JSON.stringify(v)
              : String(v);
        if (s.length > maxChars) maxChars = s.length;
        if (maxChars >= cap) break;
      }
      return clamp(maxChars * CHAR_PX + PADDING_PX, MIN_PX, MAX_PX);
    });
    return widths.map((w) => `${w}px`).join(" ");
  }, [result]);

  const columns = useMemo(() => {
    const helper = createColumnHelper<RowShape>();
    return result.columns.map((c: Column, colIdx: number) => {
      const isGeo = isGeoColumn(kind, c);
      return helper.accessor((row) => row[c.name], {
        id: c.name,
        header: () => {
          const headerContent = (
            <div>
              <div className="font-medium">{c.name}</div>
              <div className="text-[10px] font-normal text-muted-foreground">{c.type_name}</div>
            </div>
          );
          if (!isGeo) return headerContent;
          const nonNull = countNonNull(result, colIdx);
          return (
            <ContextMenu>
              <ContextMenuTrigger asChild>
                <div className="cursor-context-menu">{headerContent}</div>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem
                  disabled={nonNull === 0}
                  onSelect={() => {
                    const input = buildShowAllInput(result, c, colIdx);
                    if (input) setMapDialog(input);
                  }}
                >
                  <MapIcon className="size-3.5" />
                  Show all on map ({nonNull})
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          );
        },
        cell: (info) => {
          const v = info.getValue();
          if (!isGeo || typeof v !== "string" || v === "") {
            return formatValue(v);
          }
          return (
            <ContextMenu>
              <ContextMenuTrigger asChild>
                <span className="block w-full cursor-context-menu truncate">{formatValue(v)}</span>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem
                  onSelect={() => {
                    const rowIdx = info.row.index;
                    const sourceRow = result.rows[rowIdx];
                    setMapDialog({
                      kind: "single",
                      columnName: c.name,
                      ewkbHex: v,
                      rowData: sourceRow
                        ? buildRowData(result.columns, sourceRow, new Set([colIdx]))
                        : undefined,
                    });
                  }}
                >
                  <MapIcon className="size-3.5" />
                  Open in map
                </ContextMenuItem>
                <ContextMenuItem
                  onSelect={() =>
                    setCellPreview({
                      columnName: c.name,
                      value: info.row.original[c.name],
                    })
                  }
                >
                  <Eye className="size-3.5" />
                  Show full value
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          );
        },
      });
    });
  }, [result, kind]);

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
  const [selectedRows, setSelectedRows] = useState<Set<number>>(() => new Set());

  useEffect(() => {
    setSelected({ row: 0, col: 0 });
    setSelectedRows(new Set());
  }, [result]);

  const totalRows = result.rows.length;
  const totalCols = result.columns.length;

  const hasGeoCols = useMemo(
    () => result.columns.some((c) => isGeoColumn(kind, c)),
    [result.columns, kind],
  );
  const allRowsSelected = totalRows > 0 && selectedRows.size === totalRows;
  const headerCheckState: boolean | "indeterminate" = allRowsSelected
    ? true
    : selectedRows.size > 0
      ? "indeterminate"
      : false;

  function toggleRow(idx: number) {
    setSelectedRows((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  }

  function toggleAllRows() {
    setSelectedRows((prev) =>
      prev.size === totalRows ? new Set() : new Set(result.rows.map((_, i) => i)),
    );
  }

  function showSelectedRowsOnMap() {
    const geoCols = result.columns
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => isGeoColumn(kind, c));
    if (geoCols.length === 0 || selectedRows.size === 0) return;
    const selRows = [...selectedRows].sort((a, b) => a - b);
    const excluded = new Set(geoCols.map(({ i }) => i));
    const columns = geoCols
      .map(({ c, i: colIdx }) => ({
        name: c.name,
        values: selRows
          .map((rIdx) => {
            const r = result.rows[rIdx];
            if (!r) return null;
            const v = r[colIdx];
            if (typeof v !== "string" || v === "") return null;
            const entry: {
              rowIndex: number;
              pkLabel: string | null;
              ewkbHex: string;
              rowData: Array<[string, unknown]>;
            } = {
              rowIndex: rIdx,
              pkLabel: null,
              ewkbHex: v,
              rowData: buildRowData(result.columns, r, excluded),
            };
            return entry;
          })
          .filter(
            (
              x,
            ): x is {
              rowIndex: number;
              pkLabel: string | null;
              ewkbHex: string;
              rowData: Array<[string, unknown]>;
            } => x !== null,
          ),
      }))
      .filter((c) => c.values.length > 0);
    if (columns.length === 0) return;
    setMapDialog({
      kind: "multi",
      title: `${selRows.length} row${selRows.length === 1 ? "" : "s"}`,
      columns,
    });
  }

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
    <>
      {mapDialog && (
        <GeometryMapDialog
          open={true}
          onOpenChange={(o) => {
            if (!o) setMapDialog(null);
          }}
          connectionId={connectionId}
          input={mapDialog}
        />
      )}
      <CellPreviewDialog
        preview={cellPreview}
        onOpenChange={(o) => {
          if (!o) setCellPreview(null);
        }}
      />

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
            style={{
              gridTemplateColumns: `${hasGeoCols ? "32px " : ""}${gridTemplateColumns}`,
            }}
          >
            {hasGeoCols && (
              <div className="flex items-center justify-center border-r border-border px-2 py-1.5">
                {totalRows > 0 && (
                  <Checkbox
                    checked={headerCheckState}
                    onCheckedChange={() => toggleAllRows()}
                    aria-label="Select all rows"
                  />
                )}
              </div>
            )}
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
              const rowIdx = virtualRow.index;
              const isSelectedRow = rowIdx === selected.row;
              const isRowChecked = selectedRows.has(rowIdx);
              return (
                <div
                  key={row.id}
                  className={cn(
                    "absolute left-0 top-0 grid w-full",
                    isRowChecked
                      ? "bg-primary/15"
                      : isSelectedRow
                        ? "bg-primary/10"
                        : virtualRow.index % 2
                          ? "bg-card"
                          : "bg-transparent",
                  )}
                  style={{
                    transform: `translateY(${virtualRow.start}px)`,
                    height: virtualRow.size,
                    gridTemplateColumns: `${hasGeoCols ? "32px " : ""}${gridTemplateColumns}`,
                  }}
                >
                  {hasGeoCols && (
                    <ContextMenu>
                      <ContextMenuTrigger asChild>
                        <div className="flex items-center justify-center border-r border-b border-border/50 px-2">
                          <Checkbox
                            checked={isRowChecked}
                            onCheckedChange={() => toggleRow(rowIdx)}
                            aria-label={`Select row ${rowIdx + 1}`}
                          />
                        </div>
                      </ContextMenuTrigger>
                      <ContextMenuContent>
                        <ContextMenuItem
                          disabled={selectedRows.size === 0}
                          onSelect={() => showSelectedRowsOnMap()}
                        >
                          <MapIcon className="size-3.5" />
                          Show {selectedRows.size} selected on map
                        </ContextMenuItem>
                      </ContextMenuContent>
                    </ContextMenu>
                  )}
                  {row.getVisibleCells().map((cell, colIdx) => {
                    const isSelected = isSelectedRow && colIdx === selected.col;
                    const column = result.columns[colIdx];
                    return (
                      <div
                        key={cell.id}
                        onClick={() => setSelected({ row: virtualRow.index, col: colIdx })}
                        onDoubleClick={() => {
                          if (!column) return;
                          setCellPreview({
                            columnName: column.name,
                            value: result.rows[virtualRow.index]?.[colIdx],
                          });
                        }}
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
    </>
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
