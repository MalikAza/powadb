import { Plus, X } from "lucide-react";
import { lazy, Suspense, useEffect, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useConnections } from "../stores/connections";
import { useTabs } from "../stores/tabs";
import { QueryTabPane } from "./QueryTabPane";

const BrowseTabPane = lazy(() =>
  import("./BrowseTabPane").then((m) => ({ default: m.BrowseTabPane })),
);

const STARTER_SQL: Record<string, string> = {
  postgres: "SELECT 1 AS one, 'hello' AS greeting, now() AS ts;",
  mysql: "SELECT 1 AS one, 'hello' AS greeting, NOW() AS ts;",
};

export function QueryView() {
  const { connections, activeId } = useConnections();
  const conn = connections.find((c) => c.id === activeId);
  const { tabs, activeTabId, newQueryTab, closeTab, setActiveTab } = useTabs();

  const visibleTabs = useMemo(
    () => (activeId ? tabs.filter((t) => t.connectionId === activeId) : []),
    [tabs, activeId],
  );
  const activeTab =
    visibleTabs.find((t) => t.id === activeTabId) ?? visibleTabs[visibleTabs.length - 1] ?? null;

  useEffect(() => {
    if (!activeId) return;
    const has = useTabs.getState().tabs.some((t) => t.connectionId === activeId);
    if (!has) {
      newQueryTab(activeId, STARTER_SQL[conn?.kind ?? "postgres"]);
    }
  }, [activeId, conn?.kind, newQueryTab]);

  useEffect(() => {
    if (activeTab && activeTab.id !== activeTabId) {
      setActiveTab(activeTab.id);
    }
  }, [activeTab, activeTabId, setActiveTab]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === "t") {
        if (!activeId || !conn) return;
        e.preventDefault();
        newQueryTab(activeId, STARTER_SQL[conn.kind]);
      } else if (meta && e.key.toLowerCase() === "w") {
        if (!activeTab) return;
        e.preventDefault();
        closeTab(activeTab.id);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeId, conn, newQueryTab, activeTab, closeTab]);

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
        <Button onClick={() => newQueryTab(activeId, STARTER_SQL[conn.kind])}>
          <Plus className="size-4" /> New query tab
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <TabBar
        tabs={visibleTabs}
        activeId={activeTab.id}
        onSelect={(id) => setActiveTab(id)}
        onClose={(id) => closeTab(id)}
        onNew={() => newQueryTab(activeId, STARTER_SQL[conn.kind])}
      />
      {activeTab.kind === "browse" ? (
        <Suspense fallback={<div className="flex-1" />}>
          <BrowseTabPane key={activeTab.id} tab={activeTab} conn={conn} />
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
  onNew,
}: {
  tabs: { id: string; title: string; kind: "query" | "browse" }[];
  activeId: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
}) {
  return (
    <div className="flex h-9 shrink-0 items-center gap-0.5 border-b border-border bg-sidebar px-2">
      {tabs.map((t) => (
        <div
          key={t.id}
          onClick={() => onSelect(t.id)}
          className={cn(
            "group flex h-7 cursor-pointer items-center gap-1 rounded-md px-3 text-xs",
            t.id === activeId
              ? "bg-background text-foreground"
              : "text-muted-foreground hover:bg-sidebar-accent",
          )}
        >
          <span
            className={cn(
              "rounded px-1 font-mono text-[9px] uppercase",
              t.kind === "browse"
                ? "bg-primary/30 text-foreground"
                : "bg-muted text-muted-foreground",
            )}
          >
            {t.kind === "browse" ? "T" : "Q"}
          </span>
          <span className="truncate">{t.title}</span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onClose(t.id);
            }}
            className="rounded p-0.5 opacity-50 hover:bg-muted hover:opacity-100"
          >
            <X className="size-3" />
          </button>
        </div>
      ))}
      <Button onClick={onNew} size="icon" variant="ghost" className="size-6">
        <Plus className="size-3.5" />
      </Button>
    </div>
  );
}
