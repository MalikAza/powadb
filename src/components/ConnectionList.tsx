import {
  ChevronDown,
  ChevronRight,
  Folder as FolderIcon,
  FolderOpen,
  FolderPlus,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { useConnections } from "../stores/connections";
import type { Folder, SavedConnection } from "../types";
import { buildTree, type FolderNode } from "../utils/folderTree";
import { FolderForm } from "./FolderForm";

type Props = {
  onAdd: (folderId?: string | null) => void;
  onEdit: (id: string) => void;
};

export function ConnectionList({ onAdd, onEdit }: Props) {
  const { connections, folders, activeId, activate, remove, removeFolder } = useConnections();
  const [confirmDeleteConn, setConfirmDeleteConn] = useState<string | null>(null);
  const [confirmDeleteFolder, setConfirmDeleteFolder] = useState<string | null>(null);
  const [openFolders, setOpenFolders] = useState<Record<string, boolean>>({});
  const [folderForm, setFolderForm] = useState<{
    editing: Folder | null;
    initialParentId?: string | null;
  } | null>(null);

  useEffect(() => {
    if (!confirmDeleteConn) return;
    const t = setTimeout(() => setConfirmDeleteConn(null), 3000);
    return () => clearTimeout(t);
  }, [confirmDeleteConn]);

  useEffect(() => {
    if (!confirmDeleteFolder) return;
    const t = setTimeout(() => setConfirmDeleteFolder(null), 3000);
    return () => clearTimeout(t);
  }, [confirmDeleteFolder]);

  const tree = buildTree(folders, connections);

  return (
    <aside className="flex h-full flex-col bg-sidebar">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-sidebar-border px-3">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Connections
        </span>
        <div className="flex gap-0.5">
          <Button
            size="icon"
            variant="ghost"
            className="size-6"
            onClick={() => setFolderForm({ editing: null, initialParentId: null })}
            title="New folder"
          >
            <FolderPlus className="size-3.5" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="size-6"
            onClick={() => onAdd(null)}
            title="New connection"
          >
            <Plus className="size-3.5" />
          </Button>
        </div>
      </div>
      <ScrollArea className="flex-1">
        <div className="p-2">
          {connections.length === 0 && folders.length === 0 && (
            <p className="px-2 py-1 text-xs text-muted-foreground">No connections yet.</p>
          )}

          {tree.rootFolders.map((node) => (
            <FolderRow
              key={node.folder.id}
              node={node}
              depth={0}
              openFolders={openFolders}
              setOpenFolders={setOpenFolders}
              activeId={activeId}
              onActivate={activate}
              onEdit={onEdit}
              onAddConnHere={onAdd}
              onAddSubfolder={(parentId) =>
                setFolderForm({ editing: null, initialParentId: parentId })
              }
              onRenameFolder={(folder) => setFolderForm({ editing: folder })}
              onDeleteFolder={(folder) => {
                if (confirmDeleteFolder === folder.id) {
                  removeFolder(folder.id);
                  setConfirmDeleteFolder(null);
                } else {
                  setConfirmDeleteFolder(folder.id);
                }
              }}
              confirmDeleteFolder={confirmDeleteFolder}
              onDeleteConn={(c) => {
                if (confirmDeleteConn === c.id) {
                  remove(c.id);
                  setConfirmDeleteConn(null);
                } else {
                  setConfirmDeleteConn(c.id);
                }
              }}
              confirmDeleteConn={confirmDeleteConn}
            />
          ))}

          {tree.rootConnections.map((c) => (
            <ConnRow
              key={c.id}
              c={c}
              depth={0}
              isActive={activeId === c.id}
              onActivate={activate}
              onEdit={onEdit}
              onDelete={(c) => {
                if (confirmDeleteConn === c.id) {
                  remove(c.id);
                  setConfirmDeleteConn(null);
                } else {
                  setConfirmDeleteConn(c.id);
                }
              }}
              armed={confirmDeleteConn === c.id}
            />
          ))}
        </div>
      </ScrollArea>

      {folderForm && (
        <FolderForm
          editing={folderForm.editing}
          initialParentId={folderForm.initialParentId}
          open={true}
          onOpenChange={(open) => !open && setFolderForm(null)}
        />
      )}
    </aside>
  );
}

function FolderRow({
  node,
  depth,
  openFolders,
  setOpenFolders,
  activeId,
  onActivate,
  onEdit,
  onAddConnHere,
  onAddSubfolder,
  onRenameFolder,
  onDeleteFolder,
  confirmDeleteFolder,
  onDeleteConn,
  confirmDeleteConn,
}: {
  node: FolderNode;
  depth: number;
  openFolders: Record<string, boolean>;
  setOpenFolders: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  activeId: string | null;
  onActivate: (id: string) => void;
  onEdit: (id: string) => void;
  onAddConnHere: (folderId?: string | null) => void;
  onAddSubfolder: (parentId: string) => void;
  onRenameFolder: (folder: Folder) => void;
  onDeleteFolder: (folder: Folder) => void;
  confirmDeleteFolder: string | null;
  onDeleteConn: (c: SavedConnection) => void;
  confirmDeleteConn: string | null;
}) {
  const isOpen = openFolders[node.folder.id] ?? false;
  const armed = confirmDeleteFolder === node.folder.id;

  return (
    <div>
      <div
        className="group flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-1 hover:bg-sidebar-accent"
        style={{ paddingLeft: 8 + depth * 12 }}
        onClick={() => setOpenFolders((o) => ({ ...o, [node.folder.id]: !o[node.folder.id] }))}
      >
        {isOpen ? (
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
        )}
        {isOpen ? (
          <FolderOpen className="size-3.5 shrink-0 text-primary" />
        ) : (
          <FolderIcon className="size-3.5 shrink-0 text-primary/80" />
        )}
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{node.folder.name}</span>
        <div className="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          <Button
            size="icon"
            variant="ghost"
            className="size-5"
            onClick={(e) => {
              e.stopPropagation();
              onAddConnHere(node.folder.id);
            }}
            title="New connection here"
          >
            <Plus className="size-3" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="size-5"
            onClick={(e) => {
              e.stopPropagation();
              onAddSubfolder(node.folder.id);
            }}
            title="New subfolder"
          >
            <FolderPlus className="size-3" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="size-5"
            onClick={(e) => {
              e.stopPropagation();
              onRenameFolder(node.folder);
            }}
            title="Rename"
          >
            <Pencil className="size-3" />
          </Button>
          <Button
            size="icon"
            variant={armed ? "destructive" : "ghost"}
            className="size-5"
            onClick={(e) => {
              e.stopPropagation();
              onDeleteFolder(node.folder);
            }}
            title={armed ? "Click again to confirm (children promoted to parent)" : "Delete folder"}
          >
            <Trash2 className="size-3" />
          </Button>
        </div>
      </div>

      {isOpen && (
        <>
          {node.children.map((child) => (
            <FolderRow
              key={child.folder.id}
              node={child}
              depth={depth + 1}
              openFolders={openFolders}
              setOpenFolders={setOpenFolders}
              activeId={activeId}
              onActivate={onActivate}
              onEdit={onEdit}
              onAddConnHere={onAddConnHere}
              onAddSubfolder={onAddSubfolder}
              onRenameFolder={onRenameFolder}
              onDeleteFolder={onDeleteFolder}
              confirmDeleteFolder={confirmDeleteFolder}
              onDeleteConn={onDeleteConn}
              confirmDeleteConn={confirmDeleteConn}
            />
          ))}
          {node.connections.map((c) => (
            <ConnRow
              key={c.id}
              c={c}
              depth={depth + 1}
              isActive={activeId === c.id}
              onActivate={onActivate}
              onEdit={onEdit}
              onDelete={onDeleteConn}
              armed={confirmDeleteConn === c.id}
            />
          ))}
        </>
      )}
    </div>
  );
}

function ConnRow({
  c,
  depth,
  isActive,
  onActivate,
  onEdit,
  onDelete,
  armed,
}: {
  c: SavedConnection;
  depth: number;
  isActive: boolean;
  onActivate: (id: string) => void;
  onEdit: (id: string) => void;
  onDelete: (c: SavedConnection) => void;
  armed: boolean;
}) {
  return (
    <div
      onClick={() => onActivate(c.id)}
      onDoubleClick={() => onEdit(c.id)}
      className={cn(
        "group relative cursor-pointer rounded-md py-1 pr-2 text-xs",
        isActive ? "bg-primary/15 text-foreground" : "hover:bg-sidebar-accent",
      )}
      style={{ paddingLeft: 8 + depth * 12 + 16 }}
    >
      {c.color && (
        <span
          aria-hidden
          className="absolute left-0 top-1 bottom-1 w-1 rounded-full"
          style={{ backgroundColor: c.color, marginLeft: depth * 12 + 4 }}
        />
      )}
      <div className="flex items-center justify-between gap-1">
        <span className="min-w-0 flex-1 truncate font-medium">{c.name}</span>
        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[9px] uppercase text-muted-foreground">
          {c.kind}
        </span>
      </div>
      <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
        {c.username}@{c.host}:{c.port}/{c.database}
      </div>
      <div className="mt-1 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
        <Button
          size="icon"
          variant="ghost"
          className="size-6"
          onClick={(e) => {
            e.stopPropagation();
            onEdit(c.id);
          }}
        >
          <Pencil className="size-3" />
        </Button>
        <Button
          size="icon"
          variant={armed ? "destructive" : "ghost"}
          className="size-6"
          onClick={(e) => {
            e.stopPropagation();
            onDelete(c);
          }}
          title={armed ? "Click again to confirm" : "Delete"}
        >
          <Trash2 className="size-3" />
        </Button>
      </div>
    </div>
  );
}
