import { ArrowDown, ArrowUp, Eye, Map as MapIcon, Plus, Save, Trash2, X } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { type CellPreview, CellPreviewDialog } from "@/components/CellPreviewDialog";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { FkCell } from "@/components/FkCell";
import {
  GeometryMapDialog,
  type GeometryMapInput,
} from "@/components/GeometryMap/GeometryMapDialog";
import { ColumnResizeHandle } from "@/components/ResultsGrid/ColumnResizeHandle";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { Checkbox } from "@/components/ui/checkbox";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import type { DiagFk } from "@/ipc";
import { type ByteaDisplayMode, parseByteaInput } from "@/lib/bytea";
import { isByteaColumn, isGeoColumn } from "@/lib/columnTypes";
import { cn } from "@/lib/utils";
import { columnDisplayKey, useColumnDisplay } from "@/stores/columnDisplay";
import { type BrowseTab, useTabs } from "@/stores/tabs";
import type { Column, DbKind, QueryResult, SavedConnection } from "@/types";
import type { CompareOp, Filter } from "@/utils/sql";
import {
  buildFkFilters,
  buildRowData,
  cellDisplayString,
  type Dialogs,
  type EditingState,
  type EditOps,
  type GeomDecoded,
  geomKey,
  INITIAL_EDIT_OPS,
  pkLabelFor,
  rowKey,
} from "./helpers";
import { useBrowseColumnResize } from "./hooks/useBrowseColumnResize";
import { useBrowseDerived } from "./hooks/useBrowseDerived";
import { useBrowseMutations } from "./hooks/useBrowseMutations";
import { useDecodedGeometries } from "./hooks/useDecodedGeometries";

export function BrowseGrid({
  tab,
  conn,
  result,
  fks,
  onSort,
  onFilter,
  onRefresh,
}: {
  tab: BrowseTab;
  conn: SavedConnection;
  result: QueryResult;
  fks: DiagFk[];
  onSort: (col: string) => void;
  onFilter: (col: string, filter: Filter | null) => void;
  onRefresh: () => void;
}) {
  const openBrowseTab = useTabs((s) => s.openBrowseTab);
  const [editOps, setEditOps] = useState<EditOps>(INITIAL_EDIT_OPS);
  const { editing, insertRow, pendingDeleteRow, pendingBulkDelete, opError } = editOps;
  const setEditing = (
    next: EditOps["editing"] | ((prev: EditOps["editing"]) => EditOps["editing"]),
  ) =>
    setEditOps((prev) => ({
      ...prev,
      editing: typeof next === "function" ? next(prev.editing) : next,
    }));
  const setInsertRow = (next: EditOps["insertRow"]) =>
    setEditOps((prev) => ({ ...prev, insertRow: next }));
  const setPendingDeleteRow = (next: EditOps["pendingDeleteRow"]) =>
    setEditOps((prev) => ({ ...prev, pendingDeleteRow: next }));
  const setPendingBulkDelete = (next: EditOps["pendingBulkDelete"]) =>
    setEditOps((prev) => ({ ...prev, pendingBulkDelete: next }));
  const setOpError = (next: EditOps["opError"]) =>
    setEditOps((prev) => ({ ...prev, opError: next }));

  const [dialogs, setDialogs] = useState<Dialogs>({ map: null, cellPreview: null });
  const { map: mapDialog, cellPreview } = dialogs;
  const setMapDialog = (next: GeometryMapInput | null) =>
    setDialogs((prev) => ({ ...prev, map: next }));
  const setCellPreview = (next: CellPreview | null) =>
    setDialogs((prev) => ({ ...prev, cellPreview: next }));

  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const decodedGeoms = useDecodedGeometries(conn.id, conn.kind, result);
  const byteaModes = useColumnDisplay((s) => s.byteaModes);
  const setByteaMode = useColumnDisplay((s) => s.setByteaMode);

  // Reset selection whenever the underlying result changes.
  useEffect(() => {
    setSelected(new Set());
  }, [result]);

  const canEdit = (tab.pkCols?.length ?? 0) > 0;
  const cols = result.columns;

  const { colRefs, columnWidths, startResize, resetWidth } = useBrowseColumnResize(
    conn.id,
    tab.schema,
    tab.table,
    cols,
    result.rows,
  );

  const { byteaColMode, colIndexByName, pkColIndexes, fkByColumn } = useBrowseDerived({
    cols,
    fks,
    pkCols: tab.pkCols,
    kind: conn.kind,
    connId: conn.id,
    schema: tab.schema,
    table: tab.table,
    byteaModes,
  });

  function setColByteaMode(colIdx: number, mode: ByteaDisplayMode) {
    const col = cols[colIdx];
    if (!col) return;
    setByteaMode(columnDisplayKey(conn.id, tab.schema, tab.table, col.name), mode);
  }
  const displayString = (rowIdx: number, colIdx: number, raw: unknown) =>
    cellDisplayString(raw, decodedGeoms.get(geomKey(rowIdx, colIdx)), byteaColMode.get(colIdx));

  const selectedCount = selected.size;
  const allSelected = selectedCount > 0 && selectedCount === result.rows.length;
  const headerCheckState: boolean | "indeterminate" = allSelected
    ? true
    : selectedCount > 0
      ? "indeterminate"
      : false;

  const openFkTarget = (fk: DiagFk, row: readonly unknown[]) => {
    const filters = buildFkFilters(fk, row, cols);
    if (filters) openBrowseTab(conn.id, fk.to_schema, fk.to_table, filters);
  };

  function toggleRow(rowIdx: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(rowIdx)) next.delete(rowIdx);
      else next.add(rowIdx);
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) =>
      prev.size === result.rows.length ? new Set() : new Set(result.rows.map((_, i) => i)),
    );
  }

  const { commitEdit, commitInsert, deleteSelectedRows, deleteRow } = useBrowseMutations({
    tab,
    conn,
    cols,
    rows: result.rows,
    canEdit,
    editing,
    insertRow,
    selected,
    pkColIndexes,
    colIndexByName,
    byteaColMode,
    setEditing,
    setInsertRow,
    setSelected,
    setPendingDeleteRow,
    setPendingBulkDelete,
    setOpError,
    onRefresh,
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <BrowseToolbar
        canEdit={canEdit}
        pkCols={tab.pkCols}
        insertRow={insertRow}
        selectedCount={selectedCount}
        onStartInsert={() => {
          setInsertRow(cols.map(() => null));
          setOpError(null);
        }}
        onRequestBulkDelete={() => setPendingBulkDelete(true)}
        onClearSelection={() => setSelected(new Set())}
      />

      {opError && (
        <pre className="mb-2 m-0 whitespace-pre-wrap rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
          {opError}
        </pre>
      )}

      <div className="min-h-0 flex-1 overflow-auto rounded-md border border-border bg-card">
        <table
          className="border-collapse font-mono text-xs"
          // `width: max-content` makes the table size to the sum of `<col>`
          // widths automatically. Without an explicit width the browser would
          // stretch the table to fit the container and ignore col widths.
          style={{ tableLayout: "fixed", width: "max-content" }}
        >
          <colgroup>
            <col style={{ width: 32 }} />
            <col style={{ width: 32 }} />
            {cols.map((c, i) => (
              <col
                key={c.name}
                ref={(el) => {
                  colRefs.current[i] = el;
                }}
                style={{ width: columnWidths[i] }}
              />
            ))}
          </colgroup>
          <thead className="sticky top-0 z-10 bg-muted">
            <BrowseHeaderRow
              cols={cols}
              kind={conn.kind}
              pkCols={tab.pkCols}
              sortCol={tab.sortCol}
              sortDir={tab.sortDir}
              canEdit={canEdit}
              hasRows={result.rows.length > 0}
              headerCheckState={headerCheckState}
              byteaColMode={byteaColMode}
              setColByteaMode={setColByteaMode}
              onSort={onSort}
              onToggleAll={toggleAll}
              onStartResize={startResize}
              onResetWidth={resetWidth}
              onOpenMap={setMapDialog}
              allRows={result.rows}
              pkColIndexes={pkColIndexes}
            />
            <BrowseFilterRow
              cols={cols}
              filters={tab.filters}
              byteaColMode={byteaColMode}
              onFilter={onFilter}
              onStartResize={startResize}
              onResetWidth={resetWidth}
            />
          </thead>
          <tbody>
            {insertRow && (
              <BrowseInsertRow
                cols={cols}
                insertRow={insertRow}
                onChange={setInsertRow}
                onCommit={commitInsert}
                onCancel={() => setInsertRow(null)}
              />
            )}
            {result.rows.map((row, rowIdx) => (
              <BrowseBodyRow
                key={rowKey(pkColIndexes, row, rowIdx)}
                row={row}
                rowIdx={rowIdx}
                cols={cols}
                kind={conn.kind}
                canEdit={canEdit}
                isSelected={selected.has(rowIdx)}
                editing={editing}
                fkByColumn={fkByColumn}
                pkColIndexes={pkColIndexes}
                decodedGeoms={decodedGeoms}
                allRows={result.rows}
                selectedRows={selected}
                byteaColMode={byteaColMode}
                onToggleRow={toggleRow}
                onRequestDelete={setPendingDeleteRow}
                onStartEdit={(col, value) => setEditing({ row: rowIdx, col, value })}
                onEditChange={(value) => setEditing((prev) => (prev ? { ...prev, value } : prev))}
                onCommitEdit={commitEdit}
                onCancelEdit={() => setEditing(null)}
                onOpenMap={setMapDialog}
                onShowPreview={setCellPreview}
                onFollowFk={openFkTarget}
                displayString={displayString}
              />
            ))}
          </tbody>
        </table>
      </div>

      <BrowseDialogs
        connectionId={conn.id}
        pendingDeleteRow={pendingDeleteRow}
        setPendingDeleteRow={setPendingDeleteRow}
        onConfirmDeleteRow={deleteRow}
        pendingBulkDelete={pendingBulkDelete}
        setPendingBulkDelete={setPendingBulkDelete}
        onConfirmBulkDelete={deleteSelectedRows}
        selectedCount={selectedCount}
        mapDialog={mapDialog}
        setMapDialog={setMapDialog}
        cellPreview={cellPreview}
        setCellPreview={setCellPreview}
      />
    </div>
  );
}

function BrowseDialogs({
  connectionId,
  pendingDeleteRow,
  setPendingDeleteRow,
  onConfirmDeleteRow,
  pendingBulkDelete,
  setPendingBulkDelete,
  onConfirmBulkDelete,
  selectedCount,
  mapDialog,
  setMapDialog,
  cellPreview,
  setCellPreview,
}: {
  connectionId: string;
  pendingDeleteRow: number | null;
  setPendingDeleteRow: (next: number | null) => void;
  onConfirmDeleteRow: (rowIdx: number) => void;
  pendingBulkDelete: boolean;
  setPendingBulkDelete: (next: boolean) => void;
  onConfirmBulkDelete: () => void;
  selectedCount: number;
  mapDialog: GeometryMapInput | null;
  setMapDialog: (next: GeometryMapInput | null) => void;
  cellPreview: CellPreview | null;
  setCellPreview: (next: CellPreview | null) => void;
}) {
  return (
    <>
      <ConfirmDialog
        open={pendingDeleteRow !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDeleteRow(null);
        }}
        title="Delete this row?"
        description="The row will be permanently removed from the table."
        confirmLabel="Delete"
        onConfirm={() => {
          if (pendingDeleteRow !== null) onConfirmDeleteRow(pendingDeleteRow);
        }}
      />

      <ConfirmDialog
        open={pendingBulkDelete}
        onOpenChange={(open) => {
          if (!open) setPendingBulkDelete(false);
        }}
        title={`Delete ${selectedCount} selected row${selectedCount === 1 ? "" : "s"}?`}
        description="The selected rows will be permanently removed from the table."
        confirmLabel="Delete"
        onConfirm={onConfirmBulkDelete}
      />

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
    </>
  );
}

function BrowseHeaderRow({
  cols,
  kind,
  pkCols,
  sortCol,
  sortDir,
  canEdit,
  hasRows,
  headerCheckState,
  byteaColMode,
  setColByteaMode,
  onSort,
  onToggleAll,
  onStartResize,
  onResetWidth,
  onOpenMap,
  allRows,
  pkColIndexes,
}: {
  cols: Column[];
  kind: DbKind;
  pkCols: string[] | null;
  sortCol: string | null;
  sortDir: "asc" | "desc";
  canEdit: boolean;
  hasRows: boolean;
  headerCheckState: boolean | "indeterminate";
  byteaColMode: Map<number, ByteaDisplayMode>;
  setColByteaMode: (colIdx: number, mode: ByteaDisplayMode) => void;
  onSort: (col: string) => void;
  onToggleAll: () => void;
  onStartResize: (colIdx: number, e: React.PointerEvent) => void;
  onResetWidth: (colIdx: number) => void;
  onOpenMap: (next: GeometryMapInput | null) => void;
  allRows: readonly (readonly unknown[])[];
  pkColIndexes: number[] | null;
}) {
  return (
    <tr>
      <th className="border-b border-r border-border px-2 py-1.5 text-left">
        {canEdit && hasRows && (
          <Checkbox
            checked={headerCheckState}
            onCheckedChange={() => onToggleAll()}
            aria-label="Select all rows"
          />
        )}
      </th>
      <th
        aria-label="Row actions"
        className="border-b border-r border-border px-2 py-1.5 text-left"
      ></th>
      {cols.map((c, colIdx) => {
        const isGeo = isGeoColumn(kind, c);
        const isBytea = isByteaColumn(kind, c);
        const byteaMode = byteaColMode.get(colIdx);
        const modeBadge = isBytea && byteaMode && byteaMode !== "hex" ? byteaMode : null;
        const headerInner = (
          <div>
            <div className="flex items-center gap-1 overflow-hidden">
              {pkCols?.includes(c.name) && (
                <span title="Primary key" className="text-primary">
                  🔑
                </span>
              )}
              <span className="truncate font-medium">{c.name}</span>
              {sortCol === c.name &&
                (sortDir === "asc" ? (
                  <ArrowUp className="size-3 shrink-0 text-primary" />
                ) : (
                  <ArrowDown className="size-3 shrink-0 text-primary" />
                ))}
            </div>
            <div className="flex items-center gap-1 truncate text-[10px] font-normal text-muted-foreground">
              <span>{c.type_name}</span>
              {modeBadge && (
                <span className="rounded bg-primary/15 px-1 text-[9px] uppercase text-primary">
                  {modeBadge}
                </span>
              )}
            </div>
          </div>
        );
        const th = (
          <th
            key={c.name}
            className="cursor-pointer overflow-hidden whitespace-nowrap border-b border-border p-0 text-left hover:bg-muted-foreground/10"
            onClick={() => onSort(c.name)}
          >
            <div style={{ position: "relative" }} className="px-3 py-1.5">
              {headerInner}
              <ColumnResizeHandle
                onPointerDown={(e) => onStartResize(colIdx, e)}
                onDoubleClick={() => onResetWidth(colIdx)}
              />
            </div>
          </th>
        );
        if (isBytea) {
          return (
            <ContextMenu key={c.name}>
              <ContextMenuTrigger asChild>{th}</ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem onSelect={() => setColByteaMode(colIdx, "ulid")}>
                  Display as ULID
                  {byteaMode === "ulid" && <span className="ml-auto text-primary">✓</span>}
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => setColByteaMode(colIdx, "uuid")}>
                  Display as UUID
                  {byteaMode === "uuid" && <span className="ml-auto text-primary">✓</span>}
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => setColByteaMode(colIdx, "hex")}>
                  Display as Hex
                  {(!byteaMode || byteaMode === "hex") && (
                    <span className="ml-auto text-primary">✓</span>
                  )}
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          );
        }
        if (!isGeo) return th;
        const nonNull = allRows.reduce(
          (acc, row) => (typeof row[colIdx] === "string" && row[colIdx] !== "" ? acc + 1 : acc),
          0,
        );
        return (
          <ContextMenu key={c.name}>
            <ContextMenuTrigger asChild>{th}</ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem
                disabled={nonNull === 0}
                onSelect={() => {
                  const excluded = new Set([colIdx]);
                  const values: Array<{
                    rowIndex: number;
                    pkLabel: string | null;
                    ewkbHex: string;
                    rowData: Array<[string, unknown]>;
                  }> = [];
                  allRows.forEach((row, rowIndex) => {
                    const v = row[colIdx];
                    if (typeof v === "string" && v !== "") {
                      values.push({
                        rowIndex,
                        pkLabel: pkLabelFor(pkColIndexes, cols, row as unknown[]),
                        ewkbHex: v,
                        rowData: buildRowData(cols, row, excluded),
                      });
                    }
                  });
                  if (values.length > 0) {
                    onOpenMap({
                      kind: "multi",
                      title: `${c.name} · all rows`,
                      columns: [{ name: c.name, values }],
                    });
                  }
                }}
              >
                <MapIcon className="size-3.5" />
                Show all on map ({nonNull})
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        );
      })}
    </tr>
  );
}

function BrowseFilterRow({
  cols,
  filters,
  byteaColMode,
  onFilter,
  onStartResize,
  onResetWidth,
}: {
  cols: Column[];
  filters: Record<string, Filter>;
  byteaColMode: Map<number, ByteaDisplayMode>;
  onFilter: (col: string, filter: Filter | null) => void;
  onStartResize: (colIdx: number, e: React.PointerEvent) => void;
  onResetWidth: (colIdx: number) => void;
}) {
  return (
    <tr>
      <th aria-label="Select filter" className="border-b border-r border-border p-1"></th>
      <th aria-label="Actions filter" className="border-b border-r border-border p-1"></th>
      {cols.map((c, colIdx) => {
        const mode = byteaColMode.get(colIdx);
        const byteaMode = mode && mode !== "hex" ? mode : null;
        return (
          <th key={c.name} className="overflow-hidden border-b border-border p-0">
            <div style={{ position: "relative" }} className="p-1">
              <FilterCell
                filter={filters[c.name] ?? null}
                byteaMode={byteaMode}
                onCommit={(f) => onFilter(c.name, f)}
              />
              <ColumnResizeHandle
                onPointerDown={(e) => onStartResize(colIdx, e)}
                onDoubleClick={() => onResetWidth(colIdx)}
              />
            </div>
          </th>
        );
      })}
    </tr>
  );
}

function BrowseToolbar({
  canEdit,
  pkCols,
  insertRow,
  selectedCount,
  onStartInsert,
  onRequestBulkDelete,
  onClearSelection,
}: {
  canEdit: boolean;
  pkCols: string[] | null;
  insertRow: (string | null)[] | null;
  selectedCount: number;
  onStartInsert: () => void;
  onRequestBulkDelete: () => void;
  onClearSelection: () => void;
}) {
  return (
    <div className="mb-2 flex items-center gap-2">
      <Button size="sm" variant="secondary" onClick={onStartInsert} disabled={insertRow !== null}>
        <Plus className="size-3.5" /> Insert row
      </Button>
      {selectedCount > 0 && canEdit && (
        <Button
          size="sm"
          variant="secondary"
          onClick={onRequestBulkDelete}
          title={`Delete ${selectedCount} selected row${selectedCount === 1 ? "" : "s"}`}
        >
          <Trash2 className="size-3.5" />
          {`Delete ${selectedCount} selected`}
        </Button>
      )}
      {selectedCount > 0 && (
        <Button size="sm" variant="ghost" onClick={onClearSelection}>
          Clear selection
        </Button>
      )}
      {!canEdit && pkCols !== null && (
        <span className="text-xs text-muted-foreground">
          No primary key: edit / delete disabled
        </span>
      )}
    </div>
  );
}

function BrowseInsertRow({
  cols,
  insertRow,
  onChange,
  onCommit,
  onCancel,
}: {
  cols: Column[];
  insertRow: (string | null)[];
  onChange: (next: (string | null)[]) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  return (
    <tr className="bg-primary/10">
      <td aria-label="Insert row" className="border-b border-r border-border px-1 py-0.5"></td>
      <td className="border-b border-r border-border px-1 py-0.5">
        <div className="flex gap-0.5">
          <Button size="icon" variant="ghost" className="size-5" onClick={onCommit} title="Save">
            <Save className="size-3 text-primary" />
          </Button>
          <Button size="icon" variant="ghost" className="size-5" onClick={onCancel} title="Cancel">
            <X className="size-3" />
          </Button>
        </div>
      </td>
      {cols.map((c, i) => (
        <td key={c.name} className="border-b border-r border-border p-0">
          <Input
            value={insertRow[i] ?? ""}
            onChange={(e) => {
              const next = [...insertRow];
              next[i] = e.target.value === "" ? null : e.target.value;
              onChange(next);
            }}
            placeholder="(empty)"
            className="h-7 rounded-none border-0 px-2 text-[11px] focus-visible:ring-0"
          />
        </td>
      ))}
    </tr>
  );
}

function BrowseBodyRow({
  row,
  rowIdx,
  cols,
  kind,
  canEdit,
  isSelected,
  editing,
  fkByColumn,
  pkColIndexes,
  decodedGeoms,
  allRows,
  selectedRows,
  byteaColMode,
  onToggleRow,
  onRequestDelete,
  onStartEdit,
  onEditChange,
  onCommitEdit,
  onCancelEdit,
  onOpenMap,
  onShowPreview,
  onFollowFk,
  displayString,
}: {
  row: readonly unknown[];
  rowIdx: number;
  cols: Column[];
  kind: DbKind;
  canEdit: boolean;
  isSelected: boolean;
  editing: EditingState;
  fkByColumn: Map<string, DiagFk>;
  pkColIndexes: number[] | null;
  decodedGeoms: Map<string, GeomDecoded>;
  allRows: readonly (readonly unknown[])[];
  selectedRows: Set<number>;
  byteaColMode: Map<number, ByteaDisplayMode>;
  onToggleRow: (rowIdx: number) => void;
  onRequestDelete: (rowIdx: number) => void;
  onStartEdit: (col: number, value: string) => void;
  onEditChange: (value: string) => void;
  onCommitEdit: () => void;
  onCancelEdit: () => void;
  onOpenMap: (next: GeometryMapInput | null) => void;
  onShowPreview: (next: CellPreview | null) => void;
  onFollowFk: (fk: DiagFk, row: readonly unknown[]) => void;
  displayString: (rowIdx: number, colIdx: number, raw: unknown) => string | null;
}) {
  return (
    <tr className={cn(isSelected ? "bg-primary/10" : rowIdx % 2 === 0 ? "bg-card" : "bg-muted/30")}>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <td className="border-b border-r border-border px-2 py-0.5">
            {canEdit && (
              <Checkbox
                checked={isSelected}
                onCheckedChange={() => onToggleRow(rowIdx)}
                aria-label={`Select row ${rowIdx + 1}`}
              />
            )}
          </td>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem
            disabled={selectedRows.size === 0}
            onSelect={() => {
              const geoCols: Array<{ c: Column; i: number }> = [];
              cols.forEach((c, i) => {
                if (isGeoColumn(kind, c)) geoCols.push({ c, i });
              });
              if (geoCols.length === 0 || selectedRows.size === 0) return;
              const selRows = Array.from(selectedRows);
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
                  const r = allRows[rIdx];
                  const v = r[colIdx];
                  if (typeof v !== "string" || v === "") continue;
                  values.push({
                    rowIndex: rIdx,
                    pkLabel: pkLabelFor(pkColIndexes, cols, r as unknown[]),
                    ewkbHex: v,
                    rowData: buildRowData(cols, r, excluded),
                  });
                }
                if (values.length > 0) columns.push({ name: c.name, values });
              }
              if (columns.length === 0) return;
              onOpenMap({
                kind: "multi",
                title: `${selectedRows.size} row${selectedRows.size === 1 ? "" : "s"}`,
                columns,
              });
            }}
          >
            <MapIcon className="size-3.5" />
            Show {selectedRows.size} selected on map
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <td className="border-b border-r border-border px-1 py-0.5">
        <Button
          size="icon"
          variant="ghost"
          className="size-5"
          disabled={!canEdit}
          title={!canEdit ? "No primary key — delete disabled" : "Delete"}
          onClick={() => onRequestDelete(rowIdx)}
        >
          <Trash2 className="size-3" />
        </Button>
      </td>
      {row.map((v, colIdx) => {
        const isEditing = editing?.row === rowIdx && editing?.col === colIdx;
        const col = cols[colIdx];
        const isGeo = isGeoColumn(kind, col);
        const canOpenMap = isGeo && typeof v === "string" && v !== "";
        const fk = fkByColumn.get(col.name);
        const canFollowFk = fk !== undefined && v !== null && v !== undefined;
        const shown = displayString(rowIdx, colIdx, v);
        const startEdit = () => onStartEdit(colIdx, shown ?? "");
        const bMode = byteaColMode.get(colIdx);
        const byteaDisplay = bMode && bMode !== "hex" && shown !== null ? shown : undefined;
        return (
          <td
            key={col.name}
            className="border-b border-r border-border p-0"
            onDoubleClick={() => {
              if (!canEdit) return;
              if (isGeo) return;
              startEdit();
            }}
          >
            {isEditing && editing ? (
              <CellEditor
                value={editing.value}
                onChange={onEditChange}
                onCommit={onCommitEdit}
                onCancel={onCancelEdit}
              />
            ) : canOpenMap ? (
              <GeometryCell
                value={shown ?? (v as string)}
                onOpen={() =>
                  onOpenMap({
                    kind: "single",
                    columnName: col.name,
                    ewkbHex: v as string,
                    rowData: buildRowData(cols, row, new Set([colIdx])),
                  })
                }
                onShowFull={() => {
                  const decoded = decodedGeoms.get(geomKey(rowIdx, colIdx));
                  let previewVal: unknown = v;
                  if (decoded) {
                    try {
                      previewVal = JSON.parse(decoded.geojson);
                    } catch {
                      previewVal = decoded.geojson;
                    }
                  }
                  onShowPreview({ columnName: col.name, value: previewVal });
                }}
              />
            ) : canFollowFk ? (
              <FkCell
                value={shown ?? v}
                target={`${fk.to_schema ? `${fk.to_schema}.` : ""}${fk.to_table}`}
                onOpen={() => onFollowFk(fk, row)}
                onEdit={canEdit ? startEdit : null}
                onShowFull={() =>
                  onShowPreview({
                    columnName: col.name,
                    value: v,
                    displayValue: byteaDisplay,
                  })
                }
              />
            ) : (
              <ContextMenu>
                <ContextMenuTrigger asChild>
                  <div className="overflow-hidden text-ellipsis whitespace-nowrap px-3 py-1">
                    {shown === null ? (
                      <span className="text-muted-foreground/60">NULL</span>
                    ) : (
                      shown
                    )}
                  </div>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem
                    onSelect={() =>
                      onShowPreview({
                        columnName: col.name,
                        value: v,
                        displayValue: byteaDisplay,
                      })
                    }
                  >
                    <Eye className="size-3.5" />
                    Show full value
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            )}
          </td>
        );
      })}
    </tr>
  );
}

function GeometryCell({
  value,
  onOpen,
  onShowFull,
}: {
  value: string;
  onOpen: () => void;
  onShowFull: () => void;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className="cursor-context-menu overflow-hidden text-ellipsis whitespace-nowrap px-3 py-1">
          {value}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={onOpen}>
          <MapIcon className="size-3.5" />
          Open in map
        </ContextMenuItem>
        <ContextMenuItem onSelect={onShowFull}>
          <Eye className="size-3.5" />
          Show full value
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function CellEditor({
  value,
  onChange,
  onCommit,
  onCancel,
}: {
  value: string;
  onChange: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <Input
      ref={ref}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onCommit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onCommit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
      className="h-7 rounded-none border-0 bg-primary/20 px-3 text-[11px] focus-visible:ring-1 focus-visible:ring-primary"
    />
  );
}

type FilterOp =
  | "like"
  | "="
  | "!="
  | ">"
  | "<"
  | ">="
  | "<="
  | "between"
  | "in"
  | "is_null"
  | "is_not_null";

const OP_OPTIONS: Array<{ value: FilterOp; symbol: string; label: string }> = [
  { value: "like", symbol: "≈", label: "contains" },
  { value: "=", symbol: "=", label: "equals" },
  { value: "!=", symbol: "≠", label: "not equals" },
  { value: ">", symbol: ">", label: "greater than" },
  { value: "<", symbol: "<", label: "less than" },
  { value: ">=", symbol: "≥", label: "greater or equal" },
  { value: "<=", symbol: "≤", label: "less or equal" },
  { value: "between", symbol: "↔", label: "between" },
  { value: "in", symbol: "∈", label: "in (…)" },
  { value: "is_null", symbol: "∅", label: "is null" },
  { value: "is_not_null", symbol: "∄", label: "is not null" },
];

function filterToOp(filter: Filter | null): FilterOp {
  if (!filter) return "like";
  switch (filter.kind) {
    case "like":
      return "like";
    case "compare":
      return filter.op;
    case "between":
      return "between";
    case "in":
      return "in";
    case "is_null":
      return "is_null";
    case "is_not_null":
      return "is_not_null";
  }
}

function filterToValues(filter: Filter | null): [string, string] {
  if (!filter) return ["", ""];
  switch (filter.kind) {
    case "like":
    case "compare":
      return [filter.value, ""];
    case "between":
      return [filter.v1, filter.v2];
    case "in":
      return [filter.values.join(", "), ""];
    case "is_null":
    case "is_not_null":
      return ["", ""];
  }
}

function parseInList(raw: string): string[] {
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (trimmed !== "") out.push(trimmed);
  }
  return out;
}

function buildFilter(op: FilterOp, v1: string, v2: string): Filter | null {
  if (op === "is_null") return { kind: "is_null" };
  if (op === "is_not_null") return { kind: "is_not_null" };
  if (op === "between") {
    if (v1.trim() === "" || v2.trim() === "") return null;
    return { kind: "between", v1, v2 };
  }
  if (op === "in") {
    const values = parseInList(v1);
    if (values.length === 0) return null;
    return { kind: "in", values };
  }
  if (op === "like") {
    if (v1.trim() === "") return null;
    return { kind: "like", value: v1 };
  }
  if (v1.trim() === "") return null;
  return { kind: "compare", op: op as CompareOp, value: v1 };
}

function FilterCell({
  filter,
  byteaMode,
  onCommit,
}: {
  filter: Filter | null;
  byteaMode: ByteaDisplayMode | null;
  onCommit: (filter: Filter | null) => void;
}) {
  const [state, setState] = useState<{ op: FilterOp; v1: string; v2: string }>(() => {
    const [a, b] = filterToValues(filter);
    return { op: filterToOp(filter), v1: a, v2: b };
  });
  const { op, v1, v2 } = state;
  const setOp = (next: FilterOp) => setState((s) => ({ ...s, op: next }));
  const setV1 = (next: string) => setState((s) => ({ ...s, v1: next }));
  const setV2 = (next: string) => setState((s) => ({ ...s, v2: next }));

  // Re-sync from incoming filter (e.g. FK navigation overwrites filters).
  useEffect(() => {
    const [a, b] = filterToValues(filter);
    setState({ op: filterToOp(filter), v1: a, v2: b });
  }, [filter]);

  const commit = useEffectEvent((next: Filter | null) => onCommit(next));

  // Debounced commit on value edits; immediate commit on op change.
  useEffect(() => {
    const next = buildFilter(op, v1, v2);
    const same =
      (next === null && filter === null) ||
      (next !== null && filter !== null && JSON.stringify(next) === JSON.stringify(filter));
    if (same) return;
    const t = setTimeout(() => commit(next), 300);
    return () => clearTimeout(t);
  }, [op, v1, v2, filter]);

  function pickOp(next: FilterOp) {
    setOp(next);
    if (next === "is_null" || next === "is_not_null") {
      setV1("");
      setV2("");
    } else if (next !== "between") {
      setV2("");
    }
  }

  const currentOp = OP_OPTIONS.find((o) => o.value === op) ?? OP_OPTIONS[0];
  const needsValue = op !== "is_null" && op !== "is_not_null";
  const isBetween = op === "between";

  const byteaHint = byteaMode === "ulid" ? "ULID" : byteaMode === "uuid" ? "UUID" : null;
  const placeholder = byteaHint
    ? isBetween
      ? `min ${byteaHint}`
      : op === "in"
        ? `${byteaHint}, ${byteaHint}, …`
        : byteaHint
    : isBetween
      ? "min"
      : op === "in"
        ? "v1, v2, v3"
        : op === "like"
          ? "filter…"
          : "value";

  // Flag invalid bytea input (typed value doesn't parse as the active mode) so
  // the user sees why the filter isn't being applied.
  const v1Invalid =
    byteaMode !== null && v1.trim() !== "" && parseByteaInput(v1, byteaMode) === null;
  const v2Invalid =
    byteaMode !== null && isBetween && v2.trim() !== "" && parseByteaInput(v2, byteaMode) === null;

  const inputClass = "h-6 min-w-0 flex-1 px-1.5 text-[11px]";
  const invalidClass = "border-destructive focus-visible:ring-destructive";

  return (
    <ButtonGroup className="w-full">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="icon-xs"
            aria-label={currentOp.label}
            title={currentOp.label}
            className="text-muted-foreground"
          >
            {currentOp.symbol}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-[10rem]">
          {OP_OPTIONS.map((opt) => (
            <DropdownMenuItem key={opt.value} onSelect={() => pickOp(opt.value)}>
              <span className="w-4 text-center">{opt.symbol}</span>
              <span>{opt.label}</span>
              {op === opt.value && <span className="ml-auto text-primary">✓</span>}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {needsValue && (
        <Input
          value={v1}
          onChange={(e) => setV1(e.target.value)}
          placeholder={placeholder}
          className={cn(inputClass, v1Invalid && invalidClass)}
          title={v1Invalid ? `Invalid ${byteaHint} value` : undefined}
        />
      )}
      {isBetween && (
        <Input
          value={v2}
          onChange={(e) => setV2(e.target.value)}
          placeholder={byteaHint ? `max ${byteaHint}` : "max"}
          className={cn(inputClass, v2Invalid && invalidClass)}
          title={v2Invalid ? `Invalid ${byteaHint} value` : undefined}
        />
      )}
    </ButtonGroup>
  );
}
