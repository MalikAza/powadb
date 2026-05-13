import {
  ChevronDown,
  ChevronRight,
  Download,
  Folder as FolderIcon,
  FolderOpen,
  FolderPlus,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
  Unplug,
  Upload,
} from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { useConnections } from "../stores/connections";
import { useUi } from "../stores/ui";
import type { Folder, SavedConnection } from "../types";
import { buildTree, type FolderNode } from "../utils/folderTree";
import { ConfirmDialog } from "./ConfirmDialog";
import { FolderForm } from "./FolderForm";

type PendingDelete =
  | { kind: "conn"; id: string; name: string }
  | { kind: "folder"; id: string; name: string };

type Props = {
  onAdd: (folderId?: string | null) => void;
  onEdit: (id: string) => void;
};

export function ConnectionList({ onAdd, onEdit }: Props) {
  const {
    connections,
    folders,
    activeId,
    connectedIds,
    activate,
    remove,
    removeFolder,
    disconnect,
  } = useConnections();
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [openFolders, setOpenFolders] = useState<Record<string, boolean>>({});
  const [folderForm, setFolderForm] = useState<{
    editing: Folder | null;
    initialParentId?: string | null;
  } | null>(null);

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
              connectedIds={connectedIds}
              onActivate={activate}
              onEdit={onEdit}
              onDisconnect={disconnect}
              onAddConnHere={onAdd}
              onAddSubfolder={(parentId) =>
                setFolderForm({ editing: null, initialParentId: parentId })
              }
              onRenameFolder={(folder) => setFolderForm({ editing: folder })}
              onDeleteFolder={(folder) =>
                setPendingDelete({ kind: "folder", id: folder.id, name: folder.name })
              }
              onDeleteConn={(c) => setPendingDelete({ kind: "conn", id: c.id, name: c.name })}
            />
          ))}

          {tree.rootConnections.map((c) => (
            <ConnRow
              key={c.id}
              c={c}
              depth={0}
              isActive={activeId === c.id}
              isConnected={connectedIds.has(c.id)}
              onActivate={activate}
              onEdit={onEdit}
              onDisconnect={disconnect}
              onDelete={(c) => setPendingDelete({ kind: "conn", id: c.id, name: c.name })}
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

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        title={
          pendingDelete?.kind === "folder"
            ? `Delete folder "${pendingDelete.name}"?`
            : `Delete connection "${pendingDelete?.name ?? ""}"?`
        }
        description={
          pendingDelete?.kind === "folder"
            ? "Any connections and subfolders inside will be moved to the parent folder."
            : "The saved connection details will be permanently removed."
        }
        confirmLabel="Delete"
        onConfirm={() => {
          if (!pendingDelete) return;
          if (pendingDelete.kind === "folder") removeFolder(pendingDelete.id);
          else remove(pendingDelete.id);
          setPendingDelete(null);
        }}
      />
    </aside>
  );
}

function FolderRow({
  node,
  depth,
  openFolders,
  setOpenFolders,
  activeId,
  connectedIds,
  onActivate,
  onEdit,
  onDisconnect,
  onAddConnHere,
  onAddSubfolder,
  onRenameFolder,
  onDeleteFolder,
  onDeleteConn,
}: {
  node: FolderNode;
  depth: number;
  openFolders: Record<string, boolean>;
  setOpenFolders: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  activeId: string | null;
  connectedIds: Set<string>;
  onActivate: (id: string) => void;
  onEdit: (id: string) => void;
  onDisconnect: (id: string) => Promise<void>;
  onAddConnHere: (folderId?: string | null) => void;
  onAddSubfolder: (parentId: string) => void;
  onRenameFolder: (folder: Folder) => void;
  onDeleteFolder: (folder: Folder) => void;
  onDeleteConn: (c: SavedConnection) => void;
}) {
  const isOpen = openFolders[node.folder.id] ?? false;

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
            variant="ghost"
            className="size-5"
            onClick={(e) => {
              e.stopPropagation();
              onDeleteFolder(node.folder);
            }}
            title="Delete folder"
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
              connectedIds={connectedIds}
              onActivate={onActivate}
              onEdit={onEdit}
              onDisconnect={onDisconnect}
              onAddConnHere={onAddConnHere}
              onAddSubfolder={onAddSubfolder}
              onRenameFolder={onRenameFolder}
              onDeleteFolder={onDeleteFolder}
              onDeleteConn={onDeleteConn}
            />
          ))}
          {node.connections.map((c) => (
            <ConnRow
              key={c.id}
              c={c}
              depth={depth + 1}
              isActive={activeId === c.id}
              isConnected={connectedIds.has(c.id)}
              onActivate={onActivate}
              onEdit={onEdit}
              onDisconnect={onDisconnect}
              onDelete={onDeleteConn}
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
  isConnected,
  onActivate,
  onEdit,
  onDisconnect,
  onDelete,
}: {
  c: SavedConnection;
  depth: number;
  isActive: boolean;
  isConnected: boolean;
  onActivate: (id: string) => void;
  onEdit: (id: string) => void;
  onDisconnect: (id: string) => Promise<void>;
  onDelete: (c: SavedConnection) => void;
}) {
  const openExportDialog = useUi((s) => s.openExportDialog);
  const openImportDialog = useUi((s) => s.openImportDialog);
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
        <span
          role="status"
          aria-label={isConnected ? "Connected" : "Not connected"}
          title={isConnected ? "Connected" : "Not connected"}
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            isConnected ? "bg-emerald-500" : "bg-muted-foreground/30",
          )}
        />
        <span className="min-w-0 flex-1 truncate font-medium">{c.name}</span>
        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[9px] uppercase text-muted-foreground">
          {c.kind}
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              className="size-5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 data-[state=open]:opacity-100"
              onClick={(e) => e.stopPropagation()}
              title="More actions"
            >
              <MoreHorizontal className="size-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()} className="text-xs">
            <DropdownMenuItem onSelect={() => onEdit(c.id)}>
              <Pencil className="size-3.5" />
              Edit…
            </DropdownMenuItem>
            {isConnected && (
              <DropdownMenuItem onSelect={() => onDisconnect(c.id)}>
                <Unplug className="size-3.5" />
                Disconnect
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              onSelect={() => {
                onActivate(c.id);
                openExportDialog(c.id);
              }}
            >
              <Download className="size-3.5" />
              Export database…
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => {
                onActivate(c.id);
                openImportDialog(c.id);
              }}
            >
              <Upload className="size-3.5" />
              Import SQL file…
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => onDelete(c)}>
              <Trash2 className="size-3.5" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
        {c.username}@{c.host}:{c.port}/{c.database}
      </div>
    </div>
  );
}
