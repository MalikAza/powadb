import { Handle, type NodeProps, Position } from "@xyflow/react";
import { ChevronDown, Hash, Key, Link2, ListOrdered, Pencil, Table2, Trash2 } from "lucide-react";
import { memo, useState } from "react";
import type { DiagIndex, DiagSequence } from "@/ipc";
import type { DiagramTable } from "./types";

export type TableNodeData = {
  table: DiagramTable;
  indexes?: DiagIndex[];
  sequences?: DiagSequence[];
  onEdit?: (id: string) => void;
  onDelete?: (id: string) => void;
};

function TableNodeInner({ data, selected }: NodeProps) {
  const { table, indexes = [], sequences = [], onEdit, onDelete } = data as TableNodeData;
  const [indexesOpen, setIndexesOpen] = useState(false);
  const [sequencesOpen, setSequencesOpen] = useState(false);
  return (
    <div
      className={`group/table min-w-60 overflow-hidden rounded-md border bg-card text-xs shadow-sm ${
        selected ? "border-primary" : "border-border"
      }`}
    >
      <div className="flex items-center gap-1.5 border-b border-border bg-muted/60 px-2 py-1.5 font-medium">
        <Table2 className="size-3 shrink-0 text-muted-foreground" />
        <span className="truncate" title={`${table.schema}.${table.name}`}>
          {table.name}
        </span>
        {table.schema !== "main" && table.schema !== "public" && (
          <span className="truncate text-[10px] text-muted-foreground">{table.schema}</span>
        )}
        <div className="ml-auto flex items-center gap-0.5 opacity-0 transition-opacity group-hover/table:opacity-100">
          {onEdit && (
            <button
              type="button"
              className="rounded p-0.5 text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
              title="Edit table"
              onClick={(e) => {
                e.stopPropagation();
                onEdit(table.id);
              }}
            >
              <Pencil className="size-3" />
            </button>
          )}
          {onDelete && (
            <button
              type="button"
              className="rounded p-0.5 text-muted-foreground hover:bg-destructive/15 hover:text-destructive"
              title="Remove table from diagram"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(table.id);
              }}
            >
              <Trash2 className="size-3" />
            </button>
          )}
        </div>
      </div>
      <div className="divide-y divide-border/50">
        {table.columns.map((c) => (
          <div
            key={c.id}
            className="relative flex items-center gap-1.5 px-2 py-1 font-mono"
            title={`${c.name}: ${c.dataType}${c.nullable ? "" : " NOT NULL"}${
              c.isPk ? " · PRIMARY KEY" : ""
            }${c.isFk ? " · FOREIGN KEY" : ""}`}
          >
            <Handle
              type="target"
              position={Position.Left}
              id={`${c.id}::target`}
              className="!h-2 !w-2 !border-0 !bg-transparent"
            />
            <span className="flex w-3 shrink-0 items-center justify-center">
              {c.isPk ? (
                <Key className="size-3 text-primary" />
              ) : c.isFk ? (
                <Link2 className="size-3 text-primary" />
              ) : null}
            </span>
            <span
              className={`min-w-0 flex-1 truncate ${c.isPk ? "font-semibold" : ""} ${
                c.isFk ? "italic text-primary" : ""
              }`}
            >
              {c.name}
            </span>
            <span className="shrink-0 text-[10px] text-muted-foreground">
              {c.dataType}
              {!c.nullable && <span className="ml-0.5 text-primary">*</span>}
            </span>
            <Handle
              type="source"
              position={Position.Right}
              id={`${c.id}::source`}
              className="!h-2 !w-2 !border-0 !bg-transparent"
            />
          </div>
        ))}
      </div>
      {indexes.length > 0 && (
        <div className="border-t border-border/50">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setIndexesOpen((v) => !v);
            }}
            className="flex w-full items-center gap-1.5 bg-muted/30 px-2 py-1 text-[10px] text-muted-foreground hover:bg-muted/60"
          >
            <Hash className="size-3 shrink-0" />
            <span className="font-medium uppercase tracking-wider">Indexes ({indexes.length})</span>
            <ChevronDown
              className={`ml-auto size-3 transition-transform ${indexesOpen ? "rotate-180" : ""}`}
            />
          </button>
          {indexesOpen && (
            <ul className="divide-y divide-border/40 bg-muted/10 px-2 py-1 font-mono text-[10px]">
              {indexes.map((i) => (
                <li
                  key={i.name}
                  className="flex items-center gap-1.5 py-0.5"
                  title={`${i.name}${i.method ? ` · ${i.method}` : ""}${
                    i.is_primary ? " · PRIMARY" : i.is_unique ? " · UNIQUE" : ""
                  }`}
                >
                  <span className="flex w-3 shrink-0 items-center justify-center">
                    {i.is_primary ? (
                      <Key className="size-3 text-primary" />
                    ) : i.is_unique ? (
                      <Key className="size-3 text-muted-foreground" />
                    ) : (
                      <Hash className="size-3 text-muted-foreground" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{i.name}</span>
                  <span className="shrink-0 text-muted-foreground">({i.columns.join(", ")})</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {sequences.length > 0 && (
        <div className="border-t border-border/50">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setSequencesOpen((v) => !v);
            }}
            className="flex w-full items-center gap-1.5 bg-muted/30 px-2 py-1 text-[10px] text-muted-foreground hover:bg-muted/60"
          >
            <ListOrdered className="size-3 shrink-0" />
            <span className="font-medium uppercase tracking-wider">
              Sequences ({sequences.length})
            </span>
            <ChevronDown
              className={`ml-auto size-3 transition-transform ${sequencesOpen ? "rotate-180" : ""}`}
            />
          </button>
          {sequencesOpen && (
            <ul className="divide-y divide-border/40 bg-muted/10 px-2 py-1 font-mono text-[10px]">
              {sequences.map((s) => (
                <li
                  key={`${s.schema}.${s.name}`}
                  className="flex items-center gap-1.5 py-0.5"
                  title={`${s.schema}.${s.name} · ${s.data_type}${
                    s.owned_by_column ? ` · OWNED BY ${s.owned_by_column}` : ""
                  }`}
                >
                  <span className="flex w-3 shrink-0 items-center justify-center">
                    <ListOrdered className="size-3 text-muted-foreground" />
                  </span>
                  <span className="min-w-0 flex-1 truncate">{s.name}</span>
                  {s.owned_by_column && (
                    <span className="shrink-0 text-muted-foreground">→ {s.owned_by_column}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

export const TableNode = memo(TableNodeInner);
