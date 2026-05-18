import { ArrowUpRight, Eye, Pencil } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

const CELL_MAX_WIDTH = "280px";

type Props = {
  value: unknown;
  /** Display string for the FK target, typically `"schema.table"`. */
  target: string;
  onOpen: () => void;
  /** Pass `null` to hide the "Edit cell" item (e.g. query results). */
  onEdit: (() => void) | null;
  onShowFull: () => void;
};

export function FkCell({ value, target, onOpen, onEdit, onShowFull }: Props) {
  const display = typeof value === "object" ? JSON.stringify(value) : String(value);
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          onClick={onOpen}
          onDoubleClick={(e) => e.stopPropagation()}
          title={`Open referenced row in ${target}`}
          className="flex w-full items-center gap-1 overflow-hidden px-3 py-1 text-left text-primary hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
          style={{ maxWidth: CELL_MAX_WIDTH }}
        >
          <span className="truncate">{display}</span>
          <ArrowUpRight className="size-3 shrink-0 opacity-60" />
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={onOpen}>
          <ArrowUpRight className="size-3.5" />
          Open referenced row in {target}
        </ContextMenuItem>
        {onEdit && (
          <ContextMenuItem onSelect={onEdit}>
            <Pencil className="size-3.5" />
            Edit cell
          </ContextMenuItem>
        )}
        <ContextMenuItem onSelect={onShowFull}>
          <Eye className="size-3.5" />
          Show full value
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
