import {
  ChevronDown,
  ChevronRight,
  Database,
  Download,
  Folder as FolderIcon,
  FolderOpen,
  FolderPlus,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
  Unplug,
  Upload,
} from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { onActivateKey } from "@/lib/a11y";
import { cn } from "@/lib/utils";
import { ipc } from "../ipc";
import { useConnections } from "../stores/connections";
import { useSchema } from "../stores/schema";
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
  const connections = useConnections((s) => s.connections);
  const folders = useConnections((s) => s.folders);
  const activeId = useConnections((s) => s.activeId);
  const connectedIds = useConnections((s) => s.connectedIds);
  const activate = useConnections((s) => s.activate);
  const remove = useConnections((s) => s.remove);
  const removeFolder = useConnections((s) => s.removeFolder);
  const disconnect = useConnections((s) => s.disconnect);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [openFolders, setOpenFolders] = useState<Record<string, boolean>>({});
  const [folderForm, setFolderForm] = useState<{
    editing: Folder | null;
    initialParentId?: string | null;
  } | null>(null);

  const tree = useMemo(() => buildTree(folders, connections), [folders, connections]);

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
        role="button"
        tabIndex={0}
        aria-expanded={isOpen}
        onClick={() => setOpenFolders((o) => ({ ...o, [node.folder.id]: !o[node.folder.id] }))}
        onKeyDown={onActivateKey(() =>
          setOpenFolders((o) => ({ ...o, [node.folder.id]: !o[node.folder.id] })),
        )}
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
  // Subscribe to just this connection's state so we don't re-render the whole
  // list every time any other connection's state changes.
  const connState = useConnections((s) => s.connStates[c.id]);
  const switchDatabase = useConnections((s) => s.switchDatabase);
  const databases = useSchema((s) => s.databasesByConnection[c.id]);
  const setDatabases = useSchema((s) => s.setDatabases);
  // Only engines whose `list_databases` returns rows get a tree (Postgres /
  // MySQL); SQLite and Mongo return an empty list from that command.
  const canListDatabases = c.kind === "postgres" || c.kind === "mysql";
  const [expanded, setExpanded] = useState(false);
  const [loadingDbs, setLoadingDbs] = useState(false);

  async function toggleExpanded() {
    const next = !expanded;
    setExpanded(next);
    // Fetch lazily on first expand. `list_databases` opens the pool through the
    // proper SSH/WG tunnel via `get_or_open`, so by the time a database row is
    // clickable the pool is live and `switchDatabase` can reuse that tunnel.
    if (next && !databases) {
      setLoadingDbs(true);
      try {
        const dbs = await ipc.listDatabases(c.id);
        setDatabases(c.id, dbs);
      } catch (e) {
        toast.error(`Failed to list databases: ${String(e)}`);
        setExpanded(false);
      } finally {
        setLoadingDbs(false);
      }
    }
  }

  async function pickDatabase(db: string) {
    onActivate(c.id);
    if (db === c.database) return;
    try {
      await switchDatabase(c.id, db);
      toast.success(`Switched to ${db}`);
    } catch (e) {
      toast.error(`Failed to switch: ${String(e)}`);
    }
  }
  const stateKind = connState?.kind ?? (isConnected ? "ready" : "idle");
  const indicatorClass =
    stateKind === "ready"
      ? "bg-emerald-500"
      : stateKind === "connecting"
        ? "bg-amber-500 animate-pulse"
        : stateKind === "error"
          ? "bg-destructive"
          : "bg-muted-foreground/30";
  const indicatorTitle =
    stateKind === "ready"
      ? "Connected"
      : stateKind === "connecting"
        ? "Connecting…"
        : stateKind === "error"
          ? connState?.kind === "error"
            ? connState.message
            : "Connection error"
          : "Not connected";
  return (
    <>
      <div
        role="button"
        tabIndex={0}
        aria-pressed={isActive}
        onClick={() => onActivate(c.id)}
        onDoubleClick={() => onEdit(c.id)}
        onKeyDown={onActivateKey(() => onActivate(c.id))}
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
        {canListDatabases && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              toggleExpanded();
            }}
            className="absolute top-1.5 flex size-3.5 items-center justify-center rounded text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
            style={{ left: 8 + depth * 12 }}
            aria-expanded={expanded}
            title={expanded ? "Hide databases" : "Show databases"}
          >
            {expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
          </button>
        )}
        <div className="flex items-center justify-between gap-1">
          <span
            role="status"
            aria-label={indicatorTitle}
            title={indicatorTitle}
            className={cn("size-1.5 shrink-0 rounded-full", indicatorClass)}
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
            <DropdownMenuContent
              align="end"
              onClick={(e) => e.stopPropagation()}
              className="text-xs"
            >
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

      {expanded && (
        <div>
          {loadingDbs && !databases ? (
            <div
              className="flex items-center gap-1 py-0.5 text-[11px] text-muted-foreground"
              style={{ paddingLeft: 8 + depth * 12 + 28 }}
            >
              <Loader2 className="size-3 animate-spin" />
              <span>Loading…</span>
            </div>
          ) : databases && databases.length > 0 ? (
            databases.map((db) => {
              const isCurrent = db === c.database;
              return (
                <button
                  key={db}
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    pickDatabase(db);
                  }}
                  disabled={isCurrent}
                  title={isCurrent ? "Current database" : `Switch to ${db}`}
                  className={cn(
                    "flex w-full items-center gap-1 rounded py-0.5 pr-2 text-left text-[11px]",
                    isCurrent
                      ? "cursor-default font-medium text-primary"
                      : "text-foreground hover:bg-sidebar-accent",
                  )}
                  style={{ paddingLeft: 8 + depth * 12 + 28 }}
                >
                  <Database className="size-3 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{db}</span>
                </button>
              );
            })
          ) : (
            <div
              className="py-0.5 text-[11px] text-muted-foreground"
              style={{ paddingLeft: 8 + depth * 12 + 28 }}
            >
              No databases
            </div>
          )}
        </div>
      )}
    </>
  );
}
