import type { CollisionDetection, DragEndEvent, DragStartEvent } from "@dnd-kit/core";
import {
  closestCenter,
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useDndContext,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Database, Folder as FolderIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useConnections } from "../stores/connections";
import type { DbKind } from "../types";
import { isSelfOrDescendant } from "../utils/folderTree";

/// Drag-and-drop wiring for the connection sidebar. Rows are sortable within
/// their container (root or a folder); a folder header additionally exposes a
/// center "drop into" band so an item can be nested without reordering:
/// hovering the middle of a folder row nests, hovering its edges reorders.
///
/// Sortable/droppable ids: `conn:<id>` / `folder:<id>` rows, `into:<folderId>`
/// center bands, `sidebar-root` for the list background (drop = move to root).

export type SidebarDragData = {
  type: "conn" | "folder";
  entityId: string;
  /// "root" or the parent folder id — which container the row lives in.
  containerKey: string;
  name: string;
  kind?: DbKind;
};

export function containerKeyToFolderId(key: string): string | null {
  return key === "root" ? null : key;
}

/// Narrow the untyped `data.current` payload dnd-kit hands back to the shape
/// the sidebar rows attach (see `SortableRow` usage in ConnectionList).
function asDragData(d: unknown): SidebarDragData | undefined {
  if (typeof d !== "object" || d === null) return undefined;
  if (!("type" in d) || (d.type !== "conn" && d.type !== "folder")) return undefined;
  if (!("entityId" in d) || typeof d.entityId !== "string") return undefined;
  if (!("containerKey" in d) || typeof d.containerKey !== "string") return undefined;
  if (!("name" in d) || typeof d.name !== "string") return undefined;
  return { type: d.type, entityId: d.entityId, containerKey: d.containerKey, name: d.name };
}

/// Priority: "into" bands, then rows, then the root background, then nearest
/// row as a fallback. `pointerWithin` keeps the "middle of the row nests,
/// edges reorder" distinction that a pure closest-center scheme would lose.
const collisionDetection: CollisionDetection = (args) => {
  for (const type of ["into", "row", "rootzone"]) {
    const hits = pointerWithin({
      ...args,
      droppableContainers: args.droppableContainers.filter((c) => {
        const t = c.data.current?.type;
        return type === "row" ? t === "conn" || t === "folder" : t === type;
      }),
    });
    if (hits.length > 0) return hits;
  }
  return closestCenter(args);
};

export function SidebarDnd({ children }: { children: React.ReactNode }) {
  const moveConnection = useConnections((s) => s.moveConnection);
  const moveFolder = useConnections((s) => s.moveFolder);
  const [dragging, setDragging] = useState<SidebarDragData | null>(null);
  // The 6px activation distance keeps plain clicks / double-clicks / hover
  // buttons on the rows working — a drag only starts once the pointer moves.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  function handleDragStart(e: DragStartEvent) {
    setDragging(asDragData(e.active.data.current) ?? null);
  }

  function handleDragEnd(e: DragEndEvent) {
    setDragging(null);
    const { active, over } = e;
    const a = asDragData(active.data.current);
    if (!a || !over || active.id === over.id) return;
    const o = over.data.current;
    if (!o) return;

    // `sortable.index` is injected by SortableContext on row droppables:
    // the over-row's index within its own list, i.e. the insertion point.
    const overIndex: number = o.sortable?.index ?? Number.MAX_SAFE_INTEGER;
    const overContainer: string | null =
      typeof o.containerKey === "string" ? containerKeyToFolderId(o.containerKey) : null;
    const end = Number.MAX_SAFE_INTEGER; // append — computeContainerOrder clamps

    const done = (() => {
      if (a.type === "conn") {
        if (o.type === "into") return moveConnection(a.entityId, o.folderId, end);
        if (o.type === "rootzone") return moveConnection(a.entityId, null, end);
        if (o.type === "conn") return moveConnection(a.entityId, overContainer, overIndex);
        if (o.type === "folder") return moveConnection(a.entityId, o.entityId, end);
      } else {
        if (o.type === "into") return moveFolder(a.entityId, o.folderId, end);
        if (o.type === "rootzone") return moveFolder(a.entityId, null, end);
        if (o.type === "folder") return moveFolder(a.entityId, overContainer, overIndex);
        if (o.type === "conn") return moveFolder(a.entityId, overContainer, end);
      }
      return undefined;
    })();
    done?.catch((err) => toast.error(`Failed to move ${a.name}: ${String(err)}`));
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setDragging(null)}
    >
      {children}
      <DragOverlay dropAnimation={null}>
        {dragging && (
          <div className="flex w-fit items-center gap-1.5 rounded-md border border-sidebar-border bg-sidebar px-2 py-1 text-xs shadow-md">
            {dragging.type === "folder" ? (
              <FolderIcon className="size-3.5 shrink-0 text-primary/80" />
            ) : (
              <Database className="size-3.5 shrink-0 text-muted-foreground" />
            )}
            <span className="max-w-40 truncate font-medium">{dragging.name}</span>
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}

/// One sortable list (folders or connections of a single container).
export function SortableGroup({
  id,
  ids,
  children,
}: {
  id: string;
  ids: string[];
  children: React.ReactNode;
}) {
  return (
    <SortableContext id={id} items={ids} strategy={verticalListSortingStrategy}>
      {children}
    </SortableContext>
  );
}

/// Wraps a sidebar row (a whole FolderRow block or a ConnRow) to make it
/// draggable and displaceable.
export function SortableRow({
  id,
  data,
  children,
}: {
  id: string;
  data: SidebarDragData;
  children: React.ReactNode;
}) {
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id, data });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(isDragging && "opacity-40")}
      {...listeners}
    >
      {children}
    </div>
  );
}

/// Invisible center band over a folder header: dropping here nests the
/// dragged item inside the folder (highlighting the whole row while hovered).
/// Disabled while dragging the folder itself or one of its ancestors, so a
/// subtree can never be dropped into itself.
export function FolderDropZone({ folderId }: { folderId: string }) {
  const folders = useConnections((s) => s.folders);
  const { active } = useDndContext();
  const draggingData = asDragData(active?.data.current);
  const disabled =
    draggingData?.type === "folder" && isSelfOrDescendant(folders, draggingData.entityId, folderId);
  const { setNodeRef, isOver } = useDroppable({
    id: `into:${folderId}`,
    data: { type: "into", folderId },
    disabled,
  });
  return (
    // pointer-events-none: dnd-kit resolves drops from rects, not pointer
    // targets, so the band must never steal clicks from the hover buttons
    // sitting underneath it.
    <div ref={setNodeRef} className="pointer-events-none absolute inset-x-0 top-1/4 bottom-1/4">
      {isOver && (
        <div className="absolute inset-x-0 -inset-y-1/2 rounded-md bg-primary/10 ring-1 ring-primary/40" />
      )}
    </div>
  );
}

/// The scrollable list background. Dropping on it (outside any row) moves the
/// dragged item back to the root level.
export function RootDropZone({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: "sidebar-root",
    data: { type: "rootzone" },
  });
  return (
    <div ref={setNodeRef} className={cn(className, isOver && "bg-primary/5")}>
      {children}
    </div>
  );
}
