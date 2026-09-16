import {
  ChevronDown,
  ChevronRight,
  FileCode,
  Folder as FolderIcon,
  FolderOpen,
  FolderPlus,
  RefreshCw,
  Save,
  Search,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { onActivateKey } from "@/lib/a11y";
import { snippetSaveSchema } from "@/lib/schemas";
import { cn } from "@/lib/utils";
import type { Snippet } from "../ipc";
import { useConnections } from "../stores/connections";
import { parseByteaModesJson, useSnippets } from "../stores/snippets";
import { useTabs } from "../stores/tabs";
import { useUi } from "../stores/ui";
import type { Folder } from "../types";
import { buildTree, type FolderNode } from "../utils/folderTree";
import { ConfirmDialog } from "./ConfirmDialog";
import { FolderForm } from "./FolderForm";
import {
  FolderDropZone,
  RootDropZone,
  SidebarDnd,
  SortableGroup,
  SortableRow,
} from "./SidebarTreeDnd";

type Scope = "connection" | "global";
/** `editing === null` means "create from the active tab". */
type SaveForm = { editing: Snippet | null; name: string; scope: Scope };
type PendingDelete =
  | { kind: "snippet"; id: string; name: string }
  | { kind: "folder"; id: string; name: string };

export function SnippetsPanel() {
  const activeId = useConnections((s) => s.activeId);
  const tabs = useTabs((s) => s.tabs);
  const activeTabId = useTabs((s) => s.activeTabId);
  const newQueryTab = useTabs((s) => s.newQueryTab);
  const patchTab = useTabs((s) => s.patchTab);

  const snippets = useSnippets((s) => s.snippets);
  const folders = useSnippets((s) => s.folders);
  const loading = useSnippets((s) => s.loading);
  const reload = useSnippets((s) => s.reload);
  const saveSnippet = useSnippets((s) => s.save);
  const removeSnippet = useSnippets((s) => s.remove);
  const saveFolder = useSnippets((s) => s.saveFolder);
  const removeFolder = useSnippets((s) => s.removeFolder);
  const moveSnippet = useSnippets((s) => s.moveSnippet);
  const moveFolder = useSnippets((s) => s.moveFolder);
  const snippetSaveToken = useUi((s) => s.snippetSaveToken);

  const [query, setQuery] = useState("");
  const [form, setForm] = useState<SaveForm | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [openFolders, setOpenFolders] = useState<Record<string, boolean>>({});
  const [folderForm, setFolderForm] = useState<{
    editing: Folder | null;
    initialParentId?: string | null;
  } | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  const activeTabRaw = tabs.find((t) => t.id === activeTabId);
  const activeTab = activeTabRaw?.kind === "query" ? activeTabRaw : null;

  const openCreateForm = useCallback(() => {
    setFormError(null);
    setForm({
      editing: null,
      name: activeTab?.title ?? "",
      scope: activeId ? "connection" : "global",
    });
  }, [activeTab, activeId]);

  // Cmd+S on an unlinked tab / Cmd+Shift+S route through the ui store token.
  const firstToken = useRef(snippetSaveToken);
  useEffect(() => {
    if (snippetSaveToken === firstToken.current) return;
    openCreateForm();
  }, [snippetSaveToken, openCreateForm]);

  // Keyed on open/close only — `form` is a new object on every keystroke, and
  // depending on it would yank focus back to the name field while typing.
  const formOpen = form !== null;
  useEffect(() => {
    if (formOpen) nameInputRef.current?.focus();
  }, [formOpen]);

  const q = query.trim().toLowerCase();
  const matches = useMemo(
    () =>
      q
        ? snippets.filter(
            (s) => s.name.toLowerCase().includes(q) || s.sql.toLowerCase().includes(q),
          )
        : snippets,
    [snippets, q],
  );
  const searching = q !== "";
  const tree = useMemo(() => {
    const full = buildTree(folders, matches);
    if (!searching) return full;
    // While searching, drop the branches that contain no hit — an empty folder
    // is noise when you're looking for a specific snippet.
    const prune = (nodes: FolderNode<Snippet>[]): FolderNode<Snippet>[] =>
      nodes
        .map((n) => ({ ...n, children: prune(n.children) }))
        .filter((n) => n.items.length > 0 || n.children.length > 0);
    return { ...full, rootFolders: prune(full.rootFolders) };
  }, [folders, matches, searching]);

  async function submitForm() {
    if (!form) return;
    const parsed = snippetSaveSchema.safeParse({ name: form.name.trim(), scope: form.scope });
    if (!parsed.success) {
      setFormError(parsed.error.issues[0]?.message ?? "Invalid");
      return;
    }
    const { name, scope } = parsed.data;
    const editing = form.editing;
    // Editing keeps the snippet's own SQL/modes; creating snapshots the tab.
    if (!editing && !activeTab) return;
    const sql = editing ? editing.sql : (activeTab?.sql ?? "");
    const modes = activeTab?.byteaModes ?? {};
    const byteaModesJson = editing
      ? editing.bytea_modes_json
      : Object.keys(modes).length > 0
        ? JSON.stringify(modes)
        : null;
    try {
      const saved = await saveSnippet({
        id: editing?.id,
        name,
        sql,
        connection_id: scope === "connection" ? activeId : null,
        folder_id: editing?.folder_id ?? null,
        bytea_modes_json: byteaModesJson,
      });
      setForm(null);
      setFormError(null);
      // A fresh save from the active tab adopts it, so Cmd+S updates from here on.
      if (!editing && activeTab) {
        patchTab(activeTab.id, { snippetId: saved.id, savedSql: activeTab.sql, title: name });
      }
    } catch (err) {
      setFormError(String(err));
    }
  }

  async function rename(s: Snippet, name: string) {
    setRenamingId(null);
    const trimmed = name.trim();
    if (!trimmed || trimmed === s.name) return;
    try {
      await saveSnippet({ ...s, name: trimmed });
      for (const t of useTabs.getState().tabs) {
        if (t.kind === "query" && t.snippetId === s.id) patchTab(t.id, { title: trimmed });
      }
    } catch (err) {
      toast.error(String(err));
    }
  }

  function openInNewTab(snippet: Snippet) {
    if (!activeId) return;
    newQueryTab(activeId, snippet.sql, snippet.name, {
      byteaModes: parseByteaModesJson(snippet.bytea_modes_json),
      snippetId: snippet.id,
      savedSql: snippet.sql,
    });
  }

  const rowActions: SnippetRowActions = {
    onOpen: openInNewTab,
    onStartRename: (s) => {
      // Radix selects the item inside a flushSync during the menu's close;
      // mounting the input in that same commit doesn't stick.
      requestAnimationFrame(() => setRenamingId(s.id));
    },
    onRename: rename,
    onCancelRename: () => setRenamingId(null),
    onEdit: (s) => {
      setFormError(null);
      setForm({ editing: s, name: s.name, scope: s.connection_id ? "connection" : "global" });
    },
    onDuplicate: (s) =>
      saveSnippet({
        name: `${s.name} copy`,
        sql: s.sql,
        connection_id: s.connection_id,
        folder_id: s.folder_id,
        bytea_modes_json: s.bytea_modes_json,
      }).catch((err) => toast.error(String(err))),
    onCopySql: (s) =>
      navigator.clipboard
        .writeText(s.sql)
        .then(() => toast.success("SQL copied"))
        .catch((err) => toast.error(String(err))),
    onDelete: (s) => setPendingDelete({ kind: "snippet", id: s.id, name: s.name }),
  };

  const folderActions: FolderRowActions = {
    onAddSubfolder: (parentId) => setFolderForm({ editing: null, initialParentId: parentId }),
    onRenameFolder: (folder) => setFolderForm({ editing: folder }),
    onDeleteFolder: (folder) =>
      setPendingDelete({ kind: "folder", id: folder.id, name: folder.name }),
  };

  return (
    <div className="text-xs">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Snippets
        </span>
        <div className="flex gap-1">
          <Button
            size="icon"
            variant="ghost"
            className="size-6"
            onClick={() => setFolderForm({ editing: null, initialParentId: null })}
            title="New folder"
          >
            <FolderPlus className="size-3" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="size-6"
            onClick={() => (form ? setForm(null) : openCreateForm())}
            disabled={!activeTab}
            title="Save current tab as snippet (⌘⇧S)"
          >
            <Save className="size-3" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="size-6"
            onClick={reload}
            disabled={loading}
          >
            <RefreshCw className={loading ? "size-3 animate-spin" : "size-3"} />
          </Button>
        </div>
      </div>

      <InputGroup className="mb-2 h-7">
        <InputGroupAddon>
          <Search className="size-3" />
        </InputGroupAddon>
        <InputGroupInput
          className="h-7 text-xs"
          placeholder="Search name or SQL"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setQuery("");
          }}
        />
      </InputGroup>

      {form && (
        <div className="mb-2 grid gap-2 rounded border border-border bg-card p-2">
          <Input
            ref={nameInputRef}
            placeholder="Snippet name"
            value={form.name}
            onChange={(e) => {
              const name = e.target.value;
              setForm((f) => (f ? { ...f, name } : f));
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitForm();
              if (e.key === "Escape") setForm(null);
            }}
            className="h-7 text-xs"
          />
          <RadioGroup
            value={form.scope}
            onValueChange={(v) => setForm((f) => (f ? { ...f, scope: v as Scope } : f))}
            className="flex items-center gap-3 text-[11px]"
          >
            <div className="flex items-center gap-1.5">
              <RadioGroupItem
                value="connection"
                id="snippet-scope-connection"
                disabled={!activeId}
              />
              <Label htmlFor="snippet-scope-connection" className="cursor-pointer font-normal">
                this connection
              </Label>
            </div>
            <div className="flex items-center gap-1.5">
              <RadioGroupItem value="global" id="snippet-scope-global" />
              <Label htmlFor="snippet-scope-global" className="cursor-pointer font-normal">
                global
              </Label>
            </div>
          </RadioGroup>
          {formError && <p className="text-[11px] text-destructive">{formError}</p>}
          <div className="flex justify-end gap-1">
            <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={() => setForm(null)}>
              Cancel
            </Button>
            <Button size="sm" className="h-6 text-xs" onClick={submitForm}>
              {form.editing ? "Update" : "Save"}
            </Button>
          </div>
        </div>
      )}

      <SidebarDnd
        folders={folders}
        moveItem={moveSnippet}
        moveFolder={moveFolder}
        itemIcon={<FileCode className="size-3.5 shrink-0 text-muted-foreground" />}
      >
        <RootDropZone className="min-h-full">
          {matches.length === 0 && folders.length === 0 && !loading && (
            <p className="text-muted-foreground">
              {snippets.length === 0 ? "No snippets yet." : "No match."}
            </p>
          )}

          <SortableGroup
            id="snippet-folders:root"
            ids={tree.rootFolders.map((n) => `folder:${n.folder.id}`)}
          >
            {tree.rootFolders.map((node) => (
              <SnippetFolderRow
                key={node.folder.id}
                node={node}
                depth={0}
                containerKey="root"
                openFolders={openFolders}
                setOpenFolders={setOpenFolders}
                searching={searching}
                renamingId={renamingId}
                rowActions={rowActions}
                folderActions={folderActions}
              />
            ))}
          </SortableGroup>

          <SortableGroup id="snippets:root" ids={tree.rootItems.map((s) => `item:${s.id}`)}>
            {tree.rootItems.map((s) => (
              <SnippetRow
                key={s.id}
                snippet={s}
                depth={0}
                containerKey="root"
                renaming={renamingId === s.id}
                actions={rowActions}
              />
            ))}
          </SortableGroup>
        </RootDropZone>
      </SidebarDnd>

      {folderForm && (
        <FolderForm
          editing={folderForm.editing}
          folders={folders}
          saveFolder={saveFolder}
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
            : `Delete snippet "${pendingDelete?.name ?? ""}"?`
        }
        description={
          pendingDelete?.kind === "folder"
            ? "Any snippets and subfolders inside will be moved to the parent folder."
            : "The snippet will be permanently removed."
        }
        confirmLabel="Delete"
        onConfirm={() => {
          if (!pendingDelete) return;
          const { kind, id } = pendingDelete;
          setPendingDelete(null);
          const done = kind === "folder" ? removeFolder(id) : removeSnippet(id);
          done.catch((err) => toast.error(String(err)));
        }}
      />
    </div>
  );
}

type SnippetRowActions = {
  onOpen: (s: Snippet) => void;
  onStartRename: (s: Snippet) => void;
  onRename: (s: Snippet, name: string) => void;
  onCancelRename: () => void;
  onEdit: (s: Snippet) => void;
  onDuplicate: (s: Snippet) => void;
  onCopySql: (s: Snippet) => void;
  onDelete: (s: Snippet) => void;
};

type FolderRowActions = {
  onAddSubfolder: (parentId: string) => void;
  onRenameFolder: (folder: Folder) => void;
  onDeleteFolder: (folder: Folder) => void;
};

function SnippetFolderRow({
  node,
  depth,
  containerKey,
  openFolders,
  setOpenFolders,
  searching,
  renamingId,
  rowActions,
  folderActions,
}: {
  node: FolderNode<Snippet>;
  depth: number;
  /// "root" or the parent folder id — the DnD container this row lives in.
  containerKey: string;
  openFolders: Record<string, boolean>;
  setOpenFolders: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  /// A search is active: every surviving branch is force-expanded so hits
  /// buried in collapsed folders are still reachable.
  searching: boolean;
  renamingId: string | null;
  rowActions: SnippetRowActions;
  folderActions: FolderRowActions;
}) {
  const id = node.folder.id;
  const isOpen = searching || (openFolders[id] ?? false);
  const toggle = () => setOpenFolders((o) => ({ ...o, [id]: !o[id] }));

  return (
    <SortableRow
      id={`folder:${id}`}
      data={{ type: "folder", entityId: id, containerKey, name: node.folder.name }}
    >
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            className="group relative flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-1 hover:bg-sidebar-accent"
            style={{ paddingLeft: 8 + depth * 12 }}
            role="button"
            tabIndex={0}
            aria-expanded={isOpen}
            onClick={toggle}
            onKeyDown={onActivateKey(toggle)}
          >
            <FolderDropZone folderId={id} />
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
            <span className="min-w-0 flex-1 truncate font-medium">{node.folder.name}</span>
            <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground opacity-60">
              {node.items.length}
            </span>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="text-xs">
          <ContextMenuItem onSelect={() => folderActions.onAddSubfolder(id)}>
            New subfolder
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => folderActions.onRenameFolder(node.folder)}>
            Rename…
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            variant="destructive"
            onSelect={() => folderActions.onDeleteFolder(node.folder)}
          >
            Delete
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {isOpen && (
        <>
          <SortableGroup
            id={`snippet-folders:${id}`}
            ids={node.children.map((n) => `folder:${n.folder.id}`)}
          >
            {node.children.map((child) => (
              <SnippetFolderRow
                key={child.folder.id}
                node={child}
                depth={depth + 1}
                containerKey={id}
                openFolders={openFolders}
                setOpenFolders={setOpenFolders}
                searching={searching}
                renamingId={renamingId}
                rowActions={rowActions}
                folderActions={folderActions}
              />
            ))}
          </SortableGroup>
          <SortableGroup id={`snippets:${id}`} ids={node.items.map((s) => `item:${s.id}`)}>
            {node.items.map((s) => (
              <SnippetRow
                key={s.id}
                snippet={s}
                depth={depth + 1}
                containerKey={id}
                renaming={renamingId === s.id}
                actions={rowActions}
              />
            ))}
          </SortableGroup>
        </>
      )}
    </SortableRow>
  );
}

function SnippetRow({
  snippet,
  depth,
  containerKey,
  renaming,
  actions,
}: {
  snippet: Snippet;
  depth: number;
  containerKey: string;
  renaming: boolean;
  actions: SnippetRowActions;
}) {
  const oneLine = snippet.sql.replace(/\s+/g, " ").trim();
  return (
    <SortableRow
      id={`item:${snippet.id}`}
      data={{ type: "item", entityId: snippet.id, containerKey, name: snippet.name }}
    >
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            onDoubleClick={() => actions.onOpen(snippet)}
            title="Double-click to open in a new query tab"
            className={cn(
              "cursor-pointer rounded-md px-1.5 py-1 hover:bg-sidebar-accent",
              renaming && "bg-sidebar-accent",
            )}
            style={{ paddingLeft: 8 + depth * 12 }}
          >
            <div className="flex items-center gap-1">
              <FileCode className="size-3.5 shrink-0 text-muted-foreground" />
              {renaming ? (
                <RenameInput
                  initial={snippet.name}
                  onCommit={(name) => actions.onRename(snippet, name)}
                  onCancel={actions.onCancelRename}
                />
              ) : (
                <span className="min-w-0 flex-1 truncate font-medium">{snippet.name}</span>
              )}
              {!snippet.connection_id && (
                <span className="shrink-0 text-[9px] text-muted-foreground">global</span>
              )}
            </div>
            <div className="truncate pl-4.5 font-mono text-[11px] text-muted-foreground">
              {oneLine}
            </div>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="text-xs">
          <ContextMenuItem onSelect={() => actions.onOpen(snippet)}>
            Open in new tab
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => actions.onStartRename(snippet)}>Rename</ContextMenuItem>
          <ContextMenuItem onSelect={() => actions.onEdit(snippet)}>Edit…</ContextMenuItem>
          <ContextMenuItem onSelect={() => actions.onDuplicate(snippet)}>Duplicate</ContextMenuItem>
          <ContextMenuItem onSelect={() => actions.onCopySql(snippet)}>Copy SQL</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive" onSelect={() => actions.onDelete(snippet)}>
            Delete
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </SortableRow>
  );
}

/** In-place rename field.
 *
 *  Radix hands focus back to the context-menu trigger shortly after the menu
 *  closes, which lands on this input as an immediate blur. Rather than race it
 *  with a timer, the first blur within `FOCUS_STEAL_MS` of mount is treated as
 *  that steal and answered by taking focus back; anything later is a real blur
 *  and commits.
 *
 *  ponytail: time-bounded heuristic. If Radix ever restores focus later than
 *  the window, switch to committing on Enter + an outside-pointerdown listener.
 */
const FOCUS_STEAL_MS = 400;

function RenameInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const mountedAt = useRef(0);
  const retook = useRef(false);

  useEffect(() => {
    mountedAt.current = Date.now();
    ref.current?.focus();
    ref.current?.select();
  }, []);

  return (
    <Input
      ref={ref}
      defaultValue={initial}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      // The row is a drag handle; typing must not start a drag.
      onPointerDown={(e) => e.stopPropagation()}
      onBlur={(e) => {
        // At most once, so a focus fight can never become a loop.
        if (!retook.current && Date.now() - mountedAt.current < FOCUS_STEAL_MS) {
          retook.current = true;
          ref.current?.focus();
          return;
        }
        onCommit(e.target.value);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") onCommit(e.currentTarget.value);
        if (e.key === "Escape") onCancel();
      }}
      className="h-6 text-xs"
    />
  );
}
