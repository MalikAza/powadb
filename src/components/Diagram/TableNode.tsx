import { Handle, type NodeProps, Position } from "@xyflow/react";
import { Key, Link2, Table2 } from "lucide-react";
import { memo } from "react";
import type { DiagramTable } from "./types";

export type TableNodeData = {
  table: DiagramTable;
};

function TableNodeInner({ data, selected }: NodeProps) {
  const { table } = data as TableNodeData;
  return (
    <div
      className={`min-w-60 overflow-hidden rounded-md border bg-card text-xs shadow-sm ${
        selected ? "border-primary" : "border-border"
      }`}
    >
      <div className="flex items-center gap-1.5 border-b border-border bg-muted/60 px-2 py-1.5 font-medium">
        <Table2 className="size-3 shrink-0 text-muted-foreground" />
        <span className="truncate" title={`${table.schema}.${table.name}`}>
          {table.name}
        </span>
        {table.schema !== "main" && table.schema !== "public" && (
          <span className="ml-auto truncate text-[10px] text-muted-foreground">{table.schema}</span>
        )}
      </div>
      <div className="divide-y divide-border/50">
        {table.columns.map((c) => (
          <div
            key={c.id}
            className="relative flex items-center gap-1.5 px-2 py-1 font-mono"
            title={`${c.name}: ${c.dataType}${c.nullable ? "" : " NOT NULL"}`}
          >
            <Handle
              type="target"
              position={Position.Left}
              id={`${c.id}::target`}
              className="!h-2 !w-2 !border-0 !bg-transparent"
            />
            <span className="flex w-3 shrink-0 items-center justify-center">
              {c.isPk ? (
                <Key className="size-3 text-amber-500" />
              ) : c.isFk ? (
                <Link2 className="size-3 text-sky-500" />
              ) : null}
            </span>
            <span className={`min-w-0 flex-1 truncate ${c.isPk ? "font-semibold" : ""}`}>
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
    </div>
  );
}

export const TableNode = memo(TableNodeInner);
