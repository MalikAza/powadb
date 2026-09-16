import { listen } from "@tauri-apps/api/event";
import { Network, Plus, SquareCode, X } from "lucide-react";
import { lazy, Suspense, useEffect, useMemo } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { onActivateKey } from "@/lib/a11y";
import { cn } from "@/lib/utils";
import { useConnections } from "../stores/connections";
import { useSnippets } from "../stores/snippets";
import { isTabDirty, useTabs } from "../stores/tabs";
import { useUi } from "../stores/ui";
import { QueryTabPane } from "./QueryTabPane";

const BrowseTabPane = lazy(() =>
  import("./BrowseTabPane").then((m) => ({ default: m.BrowseTabPane })),
);

const DiagramTabPane = lazy(() =>
  import("./Diagram/DiagramTabPane").then((m) => ({ default: m.DiagramTabPane })),
);

const ObjectBrowserPane = lazy(() =>
  import("./ObjectBrowserPane").then((m) => ({ default: m.ObjectBrowserPane })),
);

export function QueryView() {
  const { connections, activeId } = useConnections();
  const conn = connections.find((c) => c.id === activeId);
  const { tabs, activeTabId, newQueryTab, openDiagramTab, closeTab, setActiveTab } = useTabs();
  const patchTab = useTabs((s) => s.patchTab);
  const snippets = useSnippets((s) => s.snippets);
  const saveSnippet = useSnippets((s) => s.save);
  const openSnippetSaveForm = useUi((s) => s.openSnippetSaveForm);
  const loadSnippets = useSnippets((s) => s.load);

  const visibleTabs = useMemo(
    () => (activeId ? tabs.filter((t) => t.connectionId === activeId) : []),
    [tabs, activeId],
  );
  const activeTab =
    visibleTabs.find((t) => t.id === activeTabId) ?? visibleTabs[visibleTabs.length - 1] ?? null;
  const tabBarItems = useMemo(
    () => visibleTabs.map((t) => ({ ...t, dirty: isTabDirty(t) })),
    [visibleTabs],
  );

  useEffect(() => {
    if (activeTab && activeTab.id !== activeTabId) {
      setActiveTab(activeTab.id);
    }
  }, [activeTab, activeTabId, setActiveTab]);

  // Loaded here rather than in SnippetsPanel: Cmd+S must know the linked
  // snippet's name/folder even when the sidebar is on another pane.
  useEffect(() => {
    loadSnippets(activeId ?? null);
  }, [activeId, loadSnippets]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      const key = e.key.toLowerCase();
      if (key === "w") {
        if (!activeTab) return;
        e.preventDefault();
        closeTab(activeTab.id);
        return;
      }
      if (key !== "s") return;
      // Cmd+S bubbles out of CodeMirror (CM6 binds nothing to it) and no Tauri
      // menu accelerator claims it, so a window listener is enough.
      e.preventDefault();
      const tab = activeTab?.kind === "query" ? activeTab : null;
      // Shift, or a tab not backed by a snippet -> "save as", handled by the
      // panel's form (it needs a name, and a scope for a brand new snippet).
      if (!tab || e.shiftKey || !tab.snippetId) {
        openSnippetSaveForm();
        return;
      }
      const existing = snippets.find((s) => s.id === tab.snippetId);
      const modes = tab.byteaModes;
      saveSnippet({
        id: tab.snippetId,
        name: existing?.name ?? tab.title,
        sql: tab.sql,
        connection_id: existing ? existing.connection_id : tab.connectionId,
        folder_id: existing?.folder_id ?? null,
        bytea_modes_json: Object.keys(modes).length > 0 ? JSON.stringify(modes) : null,
      })
        .then(() => {
          patchTab(tab.id, { savedSql: tab.sql });
          toast.success(`Snippet "${existing?.name ?? tab.title}" updated`);
        })
        .catch((err) => toast.error(String(err)));
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeTab, closeTab, openSnippetSaveForm, patchTab, saveSnippet, snippets]);

  useEffect(() => {
    const unlistenQuery = listen("new-tab", () => {
      if (!activeId) return;
      newQueryTab(activeId);
    });
    const unlistenDiagram = listen("new-diagram-tab", () => {
      if (!activeId) return;
      openDiagramTab(activeId);
    });
    return () => {
      unlistenQuery.then((fn) => fn());
      unlistenDiagram.then((fn) => fn());
    };
  }, [activeId, newQueryTab, openDiagramTab]);

  if (!activeId || !conn) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
        Select a connection on the left, or click <Plus className="mx-1 inline size-3.5" /> to add
        one.
      </div>
    );
  }

  // Object stores have no query/diagram tabs; they're opened by clicking a
  // bucket in the sidebar.
  const isObjectStore = conn.kind === "s3";

  if (!activeTab) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-sm text-muted-foreground">
        {isObjectStore ? (
          <p>Select a bucket on the left to browse its objects.</p>
        ) : (
          <>
            <p>No tab open.</p>
            <Button onClick={() => newQueryTab(activeId)}>
              <Plus className="size-4" /> New query tab
            </Button>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full min-w-0 flex-col">
      <TabBar
        tabs={tabBarItems}
        activeId={activeTab.id}
        onSelect={(id) => setActiveTab(id)}
        onClose={(id) => closeTab(id)}
        onNewQuery={isObjectStore ? null : () => newQueryTab(activeId)}
        onNewDiagram={isObjectStore ? null : () => openDiagramTab(activeId)}
      />
      {activeTab.kind === "browse" ? (
        <Suspense fallback={<div className="flex-1" />}>
          <BrowseTabPane key={activeTab.id} tab={activeTab} conn={conn} />
        </Suspense>
      ) : activeTab.kind === "diagram" ? (
        <Suspense fallback={<div className="flex-1" />}>
          <DiagramTabPane key={activeTab.id} tab={activeTab} conn={conn} />
        </Suspense>
      ) : activeTab.kind === "objects" ? (
        <Suspense fallback={<div className="flex-1" />}>
          <ObjectBrowserPane key={activeTab.id} tab={activeTab} conn={conn} />
        </Suspense>
      ) : (
        <QueryTabPane key={activeTab.id} tab={activeTab} conn={conn} />
      )}
    </div>
  );
}

function TabBar({
  tabs,
  activeId,
  onSelect,
  onClose,
  onNewQuery,
  onNewDiagram,
}: {
  tabs: {
    id: string;
    title: string;
    kind: "query" | "browse" | "diagram" | "objects";
    dirty: boolean;
  }[];
  activeId: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNewQuery: (() => void) | null;
  onNewDiagram: (() => void) | null;
}) {
  return (
    <div className="flex h-9 shrink-0 items-center border-b border-border bg-sidebar">
      <div
        className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        onWheel={(e) => {
          if (e.deltaY === 0) return;
          e.currentTarget.scrollLeft += e.deltaY;
        }}
      >
        {tabs.map((t) => (
          <div
            key={t.id}
            role="tab"
            tabIndex={0}
            aria-selected={t.id === activeId}
            aria-label={t.dirty ? `${t.title} (unsaved changes)` : undefined}
            onClick={() => onSelect(t.id)}
            onKeyDown={onActivateKey(() => onSelect(t.id))}
            className={cn(
              "group flex h-7 max-w-50 shrink-0 cursor-pointer items-center gap-1 rounded-md px-3 text-xs",
              t.id === activeId
                ? "bg-primary/10 text-foreground"
                : "text-muted-foreground hover:bg-sidebar-accent",
            )}
          >
            <span
              className={cn(
                "shrink-0 rounded px-1 font-mono text-[9px] uppercase",
                t.kind === "browse"
                  ? "bg-primary/30 text-foreground"
                  : t.kind === "diagram"
                    ? "bg-sky-500/30 text-foreground"
                    : t.kind === "objects"
                      ? "bg-amber-500/30 text-foreground"
                      : "bg-muted text-muted-foreground",
              )}
            >
              {t.kind === "browse"
                ? "T"
                : t.kind === "diagram"
                  ? "D"
                  : t.kind === "objects"
                    ? "S3"
                    : "Q"}
            </span>
            <span className="truncate">{t.title}</span>
            {t.dirty && (
              <span
                aria-hidden="true"
                title="Unsaved changes — ⌘S to update the snippet"
                className="shrink-0 text-base leading-none"
              >
                •
              </span>
            )}
            <button
              type="button"
              aria-label="Close tab"
              onClick={(e) => {
                e.stopPropagation();
                onClose(t.id);
              }}
              className="shrink-0 rounded p-0.5 opacity-50 hover:bg-muted hover:opacity-100"
            >
              <X className="size-3" />
            </button>
          </div>
        ))}
      </div>
      {(onNewQuery || onNewDiagram) && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              className="mr-2 size-6 shrink-0"
              title="New tab"
              aria-label="New tab"
            >
              <Plus className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {onNewQuery && (
              <DropdownMenuItem onClick={onNewQuery}>
                <SquareCode className="size-3.5" /> New query tab
              </DropdownMenuItem>
            )}
            {onNewDiagram && (
              <DropdownMenuItem onClick={onNewDiagram}>
                <Network className="size-3.5" /> New diagram tab
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
