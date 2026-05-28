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
import { onActivateKey } from "@/lib/a11y";
import { type ByteaDisplayMode, formatBytea } from "@/lib/bytea";
import { isByteaColumn, isGeoColumn } from "@/lib/columnTypes";
import { cn } from "@/lib/utils";
import type { DiagFk } from "../../ipc";
import type { Column, DbKind, QueryResult } from "../../types";
import { type CellPreview, CellPreviewDialog } from "../CellPreviewDialog";
import { FkCell } from "../FkCell";
import { GeometryMapDialog, type GeometryMapInput } from "../GeometryMap/GeometryMapDialog";
import { ColumnResizeHandle } from "./ColumnResizeHandle";
import { measureColumnWidths } from "./measureColumnWidths";
import { useColumnResize } from "./useColumnResize";

export type FkColumnLink = {
  fk: DiagFk;
  /** Maps each `fk.from_columns[k]` to its zero-based index in the result. */
  fromColIdxByName: Record<string, number>;
};

type RowShape = Record<string, unknown>;

type Props = {
  result: QueryResult;
  connectionId: string;
  kind: DbKind;
  /** Foreign-key link per result column index. Cells in these columns
   * render as clickable affordances that call `onOpenFkTarget`. */
  fkByColIdx?: Map<number, FkColumnLink>;
  onOpenFkTarget?: (link: FkColumnLink, row: unknown[]) => void;
  /** Controlled BYTEA display modes keyed by column name. When provided together
   * with `onByteaModeChange`, the grid becomes a controlled component and the
   * caller is responsible for persistence. Otherwise the modes live in local
   * state and reset on every new result. */
  byteaModes?: Record<string, ByteaDisplayMode>;
  onByteaModeChange?: (colName: string, mode: ByteaDisplayMode) => void;
};

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

type BuildColumnsArgs = {
  result: QueryResult;
  kind: DbKind;
  getByteaMode: (colName: string) => ByteaDisplayMode | undefined;
  setByteaMode: (colName: string, mode: ByteaDisplayMode) => void;
  setMapDialog: (next: GeometryMapInput | null) => void;
  setCellPreview: (next: CellPreview | null) => void;
};

function buildTableColumns({
  result,
  kind,
  getByteaMode,
  setByteaMode,
  setMapDialog,
  setCellPreview,
}: BuildColumnsArgs) {
  const helper = createColumnHelper<RowShape>();
  return result.columns.map((c: Column, colIdx: number) => {
    const isGeo = isGeoColumn(kind, c);
    const isBytea = isByteaColumn(kind, c);
    return helper.accessor((row) => row[c.name], {
      id: c.name,
      header: () =>
        renderColumnHeader({
          column: c,
          colIdx,
          isGeo,
          isBytea,
          result,
          byteaMode: getByteaMode(c.name),
          setByteaMode,
          setMapDialog,
        }),
      cell: (info) => {
        const v = info.getValue();
        if (isBytea) {
          if (typeof v !== "string" || v === "") return formatValue(v);
          const mode = getByteaMode(c.name);
          if (mode && mode !== "hex") {
            const formatted = formatBytea(v, mode);
            if (formatted !== null) return formatted;
          }
          return formatValue(v);
        }
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
}

type RenderHeaderArgs = {
  column: Column;
  colIdx: number;
  isGeo: boolean;
  isBytea: boolean;
  result: QueryResult;
  byteaMode: ByteaDisplayMode | undefined;
  setByteaMode: (colName: string, mode: ByteaDisplayMode) => void;
  setMapDialog: (next: GeometryMapInput | null) => void;
};

function renderColumnHeader({
  column: c,
  colIdx,
  isGeo,
  isBytea,
  result,
  byteaMode,
  setByteaMode,
  setMapDialog,
}: RenderHeaderArgs) {
  const modeBadge = isBytea && byteaMode && byteaMode !== "hex" ? byteaMode : null;
  const headerContent = (
    <div>
      <div className="font-medium">{c.name}</div>
      <div className="flex items-center gap-1 text-[10px] font-normal text-muted-foreground">
        <span>{c.type_name}</span>
        {modeBadge && (
          <span className="rounded bg-primary/15 px-1 text-[9px] uppercase text-primary">
            {modeBadge}
          </span>
        )}
      </div>
    </div>
  );
  if (isBytea) {
    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="cursor-context-menu">{headerContent}</div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={() => setByteaMode(c.name, "ulid")}>
            Display as ULID
            {byteaMode === "ulid" && <span className="ml-auto text-primary">✓</span>}
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => setByteaMode(c.name, "uuid")}>
            Display as UUID
            {byteaMode === "uuid" && <span className="ml-auto text-primary">✓</span>}
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => setByteaMode(c.name, "hex")}>
            Display as Hex
            {(!byteaMode || byteaMode === "hex") && <span className="ml-auto text-primary">✓</span>}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
  }
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
}

export function ResultsGrid({
  result,
  connectionId,
  kind,
  fkByColIdx,
  onOpenFkTarget,
  byteaModes: controlledByteaModes,
  onByteaModeChange,
}: Props) {
  const [dialogs, setDialogs] = useState<{
    map: GeometryMapInput | null;
    cellPreview: CellPreview | null;
  }>({ map: null, cellPreview: null });
  const mapDialog = dialogs.map;
  const cellPreview = dialogs.cellPreview;
  const setMapDialog = (next: GeometryMapInput | null) =>
    setDialogs((prev) => ({ ...prev, map: next }));
  const setCellPreview = (next: CellPreview | null) =>
    setDialogs((prev) => ({ ...prev, cellPreview: next }));
  // BYTEA presentation: when the parent supplies `byteaModes` + `onByteaModeChange`,
  // we run controlled (the parent owns persistence — see QueryTabPane). Otherwise
  // fall back to per-result local state, reset on each new result.
  const controlled = !!controlledByteaModes && !!onByteaModeChange;
  const [localByteaModes, setLocalByteaModes] = useState<Map<string, ByteaDisplayMode>>(
    () => new Map(),
  );
  useEffect(() => {
    if (!controlled) setLocalByteaModes(new Map());
  }, [result, controlled]);
  function getByteaMode(colName: string): ByteaDisplayMode | undefined {
    return controlled ? controlledByteaModes?.[colName] : localByteaModes.get(colName);
  }
  function setByteaMode(colName: string, mode: ByteaDisplayMode) {
    if (controlled) {
      onByteaModeChange?.(colName, mode);
      return;
    }
    setLocalByteaModes((prev) => {
      const next = new Map(prev);
      next.set(colName, mode);
      return next;
    });
  }
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

  // Compute one default width per column from the longest stringified value;
  // `useColumnResize` keeps mutable state and lets the user drag to override.
  // Both header and every body row consume the same template string so columns
  // stay aligned regardless of any one row's content.
  const initialColumnWidths = useMemo(
    () => measureColumnWidths(result.columns, result.rows),
    [result],
  );
  const { widths: columnWidths, startResize, resetWidth } = useColumnResize(initialColumnWidths);
  const gridTemplateColumns = useMemo(
    () => columnWidths.map((w) => `${w}px`).join(" "),
    [columnWidths],
  );

  const columns = useMemo(
    () =>
      buildTableColumns({
        result,
        kind,
        getByteaMode,
        setByteaMode,
        setMapDialog,
        setCellPreview,
      }),
    [result, kind, controlled, controlledByteaModes, localByteaModes],
  );

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

  const [selection, setSelection] = useState<{
    cursor: { row: number; col: number };
    rows: Set<number>;
  }>({ cursor: { row: 0, col: 0 }, rows: new Set() });
  const selected = selection.cursor;
  const selectedRows = selection.rows;
  const setSelected = (
    next:
      | { row: number; col: number }
      | ((s: { row: number; col: number }) => { row: number; col: number }),
  ) =>
    setSelection((prev) => ({
      ...prev,
      cursor: typeof next === "function" ? next(prev.cursor) : next,
    }));
  const setSelectedRows = (next: Set<number> | ((s: Set<number>) => Set<number>)) =>
    setSelection((prev) => ({
      ...prev,
      rows: typeof next === "function" ? next(prev.rows) : next,
    }));

  useEffect(() => {
    setSelection({ cursor: { row: 0, col: 0 }, rows: new Set() });
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

  const showSelectedRowsOnMap = () =>
    showSelectedRowsOnMapHelper({ result, kind, selectedRows, setMapDialog });

  const onKeyDown = makeGridKeyDownHandler({
    totalRows,
    totalCols,
    selected,
    setSelected,
    rowVirtualizer,
    getCellValue: (row, col) => result.rows[row]?.[col],
  });

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
          <HeaderRow
            headers={table.getHeaderGroups()[0]?.headers ?? []}
            hasGeoCols={hasGeoCols}
            gridTemplateColumns={gridTemplateColumns}
            totalRows={totalRows}
            headerCheckState={headerCheckState}
            selectedCol={selected.col}
            onToggleAllRows={toggleAllRows}
            onSelectCol={(colIdx) => setSelected((s) => ({ ...s, col: colIdx }))}
            onStartResize={startResize}
            onResetWidth={resetWidth}
          />

          <div
            style={{
              height: rowVirtualizer.getTotalSize(),
              position: "relative",
            }}
          >
            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
              const row = table.getRowModel().rows[virtualRow.index];
              if (!row) return null;
              const rowIdx = virtualRow.index;
              return (
                <BodyRow
                  key={row.id}
                  row={row}
                  rowIdx={rowIdx}
                  virtualStart={virtualRow.start}
                  virtualSize={virtualRow.size}
                  hasGeoCols={hasGeoCols}
                  gridTemplateColumns={gridTemplateColumns}
                  isSelectedRow={rowIdx === selected.row}
                  isRowChecked={selectedRows.has(rowIdx)}
                  selectedCol={selected.col}
                  selectedRowsSize={selectedRows.size}
                  resultColumns={result.columns}
                  rawRow={result.rows[rowIdx]}
                  fkByColIdx={fkByColIdx}
                  onOpenFkTarget={onOpenFkTarget}
                  onToggleRow={toggleRow}
                  onShowSelectedOnMap={showSelectedRowsOnMap}
                  onSelectCell={(r, c) => setSelected({ row: r, col: c })}
                  onShowCellPreview={(columnName, value) => {
                    const col = result.columns.find((c) => c.name === columnName);
                    let displayValue: string | undefined;
                    if (col && isByteaColumn(kind, col) && typeof value === "string") {
                      const mode = getByteaMode(columnName);
                      if (mode && mode !== "hex") {
                        const formatted = formatBytea(value, mode);
                        if (formatted !== null) displayValue = formatted;
                      }
                    }
                    setCellPreview({ columnName, value, displayValue });
                  }}
                />
              );
            })}
          </div>
        </div>
      </div>
    </>
  );
}

type HeaderRowProps = {
  headers: ReturnType<
    ReturnType<typeof useReactTable<RowShape>>["getHeaderGroups"]
  >[number]["headers"];
  hasGeoCols: boolean;
  gridTemplateColumns: string;
  totalRows: number;
  headerCheckState: boolean | "indeterminate";
  selectedCol: number;
  onToggleAllRows: () => void;
  onSelectCol: (colIdx: number) => void;
  onStartResize: (colIdx: number, e: React.PointerEvent) => void;
  onResetWidth: (colIdx: number) => void;
};

function HeaderRow({
  headers,
  hasGeoCols,
  gridTemplateColumns,
  totalRows,
  headerCheckState,
  selectedCol,
  onToggleAllRows,
  onSelectCol,
  onStartResize,
  onResetWidth,
}: HeaderRowProps) {
  return (
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
              onCheckedChange={() => onToggleAllRows()}
              aria-label="Select all rows"
            />
          )}
        </div>
      )}
      {headers.map((header, colIdx) => (
        <div
          key={header.id}
          role="columnheader"
          tabIndex={0}
          onClick={() => onSelectCol(colIdx)}
          onKeyDown={onActivateKey(() => onSelectCol(colIdx))}
          className={cn(
            "relative cursor-pointer overflow-hidden whitespace-nowrap border-r border-border px-3 py-1.5 font-mono text-xs",
            selectedCol === colIdx && "bg-primary/20",
          )}
        >
          {flexRender(header.column.columnDef.header, header.getContext())}
          <ColumnResizeHandle
            onPointerDown={(e) => onStartResize(colIdx, e)}
            onDoubleClick={() => onResetWidth(colIdx)}
          />
        </div>
      ))}
    </div>
  );
}

type TableRow = ReturnType<
  ReturnType<typeof useReactTable<RowShape>>["getRowModel"]
>["rows"][number];

type BodyRowProps = {
  row: TableRow;
  rowIdx: number;
  virtualStart: number;
  virtualSize: number;
  hasGeoCols: boolean;
  gridTemplateColumns: string;
  isSelectedRow: boolean;
  isRowChecked: boolean;
  selectedCol: number;
  selectedRowsSize: number;
  resultColumns: Column[];
  rawRow: readonly unknown[] | undefined;
  fkByColIdx?: Map<number, FkColumnLink>;
  onOpenFkTarget?: (link: FkColumnLink, row: unknown[]) => void;
  onToggleRow: (idx: number) => void;
  onShowSelectedOnMap: () => void;
  onSelectCell: (row: number, col: number) => void;
  onShowCellPreview: (columnName: string, value: unknown) => void;
};

function BodyRow({
  row,
  rowIdx,
  virtualStart,
  virtualSize,
  hasGeoCols,
  gridTemplateColumns,
  isSelectedRow,
  isRowChecked,
  selectedCol,
  selectedRowsSize,
  resultColumns,
  rawRow,
  fkByColIdx,
  onOpenFkTarget,
  onToggleRow,
  onShowSelectedOnMap,
  onSelectCell,
  onShowCellPreview,
}: BodyRowProps) {
  return (
    <div
      className={cn(
        "absolute left-0 top-0 grid w-full",
        isRowChecked
          ? "bg-primary/15"
          : isSelectedRow
            ? "bg-primary/10"
            : rowIdx % 2
              ? "bg-card"
              : "bg-transparent",
      )}
      style={{
        transform: `translateY(${virtualStart}px)`,
        height: virtualSize,
        gridTemplateColumns: `${hasGeoCols ? "32px " : ""}${gridTemplateColumns}`,
      }}
    >
      {hasGeoCols && (
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div className="flex items-center justify-center border-r border-b border-border/50 px-2">
              <Checkbox
                checked={isRowChecked}
                onCheckedChange={() => onToggleRow(rowIdx)}
                aria-label={`Select row ${rowIdx + 1}`}
              />
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem
              disabled={selectedRowsSize === 0}
              onSelect={() => onShowSelectedOnMap()}
            >
              <MapIcon className="size-3.5" />
              Show {selectedRowsSize} selected on map
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      )}
      {row.getVisibleCells().map((cell, colIdx) => {
        const column = resultColumns[colIdx];
        const cellValue = rawRow?.[colIdx];
        const fkLink = fkByColIdx?.get(colIdx);
        const renderAsFk =
          !!fkLink && cellValue !== null && cellValue !== undefined && !!onOpenFkTarget;
        const isSelected = isSelectedRow && colIdx === selectedCol;
        return (
          <div
            key={cell.id}
            role="gridcell"
            tabIndex={0}
            onClick={() => onSelectCell(rowIdx, colIdx)}
            onKeyDown={onActivateKey(() => onSelectCell(rowIdx, colIdx))}
            onDoubleClick={() => {
              if (!column || renderAsFk) return;
              onShowCellPreview(column.name, cellValue);
            }}
            className={cn(
              "overflow-hidden text-ellipsis whitespace-nowrap border-r border-b border-border/50 font-mono text-xs",
              renderAsFk ? "p-0" : "px-3 py-1",
              isSelected && "bg-primary/30 outline outline-1 -outline-offset-1 outline-primary",
            )}
          >
            {renderAsFk && fkLink ? (
              <FkCell
                value={cellValue}
                target={`${fkLink.fk.to_schema ? `${fkLink.fk.to_schema}.` : ""}${fkLink.fk.to_table}`}
                onOpen={() => {
                  if (rawRow && onOpenFkTarget) {
                    onOpenFkTarget(fkLink, rawRow as unknown[]);
                  }
                }}
                onEdit={null}
                onShowFull={() => {
                  if (!column) return;
                  onShowCellPreview(column.name, cellValue);
                }}
              />
            ) : (
              flexRender(cell.column.columnDef.cell, cell.getContext())
            )}
          </div>
        );
      })}
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

type ShowSelectedOnMapArgs = {
  result: QueryResult;
  kind: DbKind;
  selectedRows: Set<number>;
  setMapDialog: (next: GeometryMapInput | null) => void;
};

function showSelectedRowsOnMapHelper({
  result,
  kind,
  selectedRows,
  setMapDialog,
}: ShowSelectedOnMapArgs) {
  const geoCols: Array<{ c: Column; i: number }> = [];
  result.columns.forEach((c, i) => {
    if (isGeoColumn(kind, c)) geoCols.push({ c, i });
  });
  if (geoCols.length === 0 || selectedRows.size === 0) return;
  const selRows = Array.from(selectedRows).sort((a, b) => a - b);
  const excluded = new Set<number>();
  for (const { i } of geoCols) excluded.add(i);
  type EntryValue = {
    rowIndex: number;
    pkLabel: string | null;
    ewkbHex: string;
    rowData: Array<[string, unknown]>;
  };
  const columns: Array<{ name: string; values: EntryValue[] }> = [];
  for (const { c, i: colIdx } of geoCols) {
    const values: EntryValue[] = [];
    for (const rIdx of selRows) {
      const r = result.rows[rIdx];
      if (!r) continue;
      const v = r[colIdx];
      if (typeof v !== "string" || v === "") continue;
      values.push({
        rowIndex: rIdx,
        pkLabel: null,
        ewkbHex: v,
        rowData: buildRowData(result.columns, r, excluded),
      });
    }
    if (values.length > 0) columns.push({ name: c.name, values });
  }
  if (columns.length === 0) return;
  setMapDialog({
    kind: "multi",
    title: `${selRows.length} row${selRows.length === 1 ? "" : "s"}`,
    columns,
  });
}

type Cursor = { row: number; col: number };

type KeyDownArgs = {
  totalRows: number;
  totalCols: number;
  selected: Cursor;
  setSelected: (next: Cursor | ((s: Cursor) => Cursor)) => void;
  rowVirtualizer: ReturnType<typeof useVirtualizer<HTMLDivElement, Element>>;
  getCellValue: (row: number, col: number) => unknown;
};

function makeGridKeyDownHandler({
  totalRows,
  totalCols,
  selected,
  setSelected,
  rowVirtualizer,
  getCellValue,
}: KeyDownArgs) {
  function move(dRow: number, dCol: number) {
    setSelected((s) => {
      const row = clamp(s.row + dRow, 0, Math.max(0, totalRows - 1));
      const col = clamp(s.col + dCol, 0, Math.max(0, totalCols - 1));
      if (dRow !== 0) rowVirtualizer.scrollToIndex(row, { align: "auto" });
      return { row, col };
    });
  }
  function copyCell() {
    const v = getCellValue(selected.row, selected.col);
    const text =
      v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    navigator.clipboard.writeText(text);
  }
  return function onKeyDown(e: React.KeyboardEvent) {
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
  };
}
