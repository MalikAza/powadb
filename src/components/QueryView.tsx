import { listen } from "@tauri-apps/api/event";
import { Network, Plus, SquareCode, X } from "lucide-react";
import { lazy, Suspense, useEffect, useMemo } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useConnections } from "../stores/connections";
import { useTabs } from "../stores/tabs";
import { QueryTabPane } from "./QueryTabPane";

const BrowseTabPane = lazy(() =>
  import("./BrowseTabPane").then((m) => ({ default: m.BrowseTabPane })),
);

const DiagramTabPane = lazy(() =>
  import("./Diagram/DiagramTabPane").then((m) => ({ default: m.DiagramTabPane })),
);

export function QueryView() {
  const { connections, activeId } = useConnections();
  const conn = connections.find((c) => c.id === activeId);
  const { tabs, activeTabId, newQueryTab, openDiagramTab, closeTab, setActiveTab } = useTabs();

  const visibleTabs = useMemo(
    () => (activeId ? tabs.filter((t) => t.connectionId === activeId) : []),
    [tabs, activeId],
  );
  const activeTab =
    visibleTabs.find((t) => t.id === activeTabId) ?? visibleTabs[visibleTabs.length - 1] ?? null;

  useEffect(() => {
    if (activeTab && activeTab.id !== activeTabId) {
      setActiveTab(activeTab.id);
    }
  }, [activeTab, activeTabId, setActiveTab]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === "w") {
        if (!activeTab) return;
        e.preventDefault();
        closeTab(activeTab.id);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeTab, closeTab]);

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

  if (!activeTab) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-sm text-muted-foreground">
        <p>No tab open.</p>
        <Button onClick={() => newQueryTab(activeId)}>
          <Plus className="size-4" /> New query tab
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full min-w-0 flex-col">
      <TabBar
        tabs={visibleTabs}
        activeId={activeTab.id}
        onSelect={(id) => setActiveTab(id)}
        onClose={(id) => closeTab(id)}
        onNewQuery={() => newQueryTab(activeId)}
        onNewDiagram={() => openDiagramTab(activeId)}
      />
      {activeTab.kind === "browse" ? (
        <Suspense fallback={<div className="flex-1" />}>
          <BrowseTabPane key={activeTab.id} tab={activeTab} conn={conn} />
        </Suspense>
      ) : activeTab.kind === "diagram" ? (
        <Suspense fallback={<div className="flex-1" />}>
          <DiagramTabPane key={activeTab.id} tab={activeTab} conn={conn} />
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
  tabs: { id: string; title: string; kind: "query" | "browse" | "diagram" }[];
  activeId: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNewQuery: () => void;
  onNewDiagram: () => void;
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
            onClick={() => onSelect(t.id)}
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
                    : "bg-muted text-muted-foreground",
              )}
            >
              {t.kind === "browse" ? "T" : t.kind === "diagram" ? "D" : "Q"}
            </span>
            <span className="truncate">{t.title}</span>
            <button
              type="button"
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
          <DropdownMenuItem onClick={onNewQuery}>
            <SquareCode className="size-3.5" /> New query tab
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onNewDiagram}>
            <Network className="size-3.5" /> New diagram tab
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
