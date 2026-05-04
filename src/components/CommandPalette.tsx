import { Download, Play, Plus, Upload, X } from "lucide-react";
import { useEffect, useState } from "react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { ipc } from "../ipc";
import { useConnections } from "../stores/connections";
import { newQueryId, useTabs } from "../stores/tabs";
import { useUi } from "../stores/ui";

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const { connections, activeId, activate } = useConnections();
  const { tabs, activeTabId, newQueryTab, closeTab, patchTab } = useTabs();
  const openExportDialog = useUi((s) => s.openExportDialog);
  const openImportDialog = useUi((s) => s.openImportDialog);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const activeTab = tabs.find((t) => t.id === activeTabId);
  const activeQueryTab = activeTab?.kind === "query" ? activeTab : null;

  function close() {
    setOpen(false);
  }

  async function runActiveTab() {
    if (!activeQueryTab || !activeId) return;
    const queryId = newQueryId();
    patchTab(activeQueryTab.id, {
      loading: true,
      error: null,
      result: null,
      runningQueryId: queryId,
    });
    try {
      const result = await ipc.runQuery(activeId, queryId, activeQueryTab.sql);
      patchTab(activeQueryTab.id, { result, loading: false, runningQueryId: null });
    } catch (e) {
      patchTab(activeQueryTab.id, { error: String(e), loading: false, runningQueryId: null });
    }
  }

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Type a command…" />
      <CommandList className="max-h-[60vh]">
        <CommandEmpty>No matches.</CommandEmpty>

        <CommandGroup heading="Actions">
          <CommandItem
            value="new query tab"
            onSelect={() => {
              if (activeId) newQueryTab(activeId);
              close();
            }}
          >
            <Plus className="size-3.5" />
            New query tab
          </CommandItem>
          {activeQueryTab && !activeQueryTab.loading && (
            <CommandItem
              value="run current query"
              onSelect={() => {
                runActiveTab();
                close();
              }}
            >
              <Play className="size-3.5" />
              Run current query
            </CommandItem>
          )}
          {activeQueryTab?.runningQueryId && (
            <CommandItem
              value="cancel running query"
              onSelect={() => {
                if (activeQueryTab.runningQueryId) ipc.cancelQuery(activeQueryTab.runningQueryId);
                close();
              }}
            >
              Cancel running query
            </CommandItem>
          )}
          {activeTab && (
            <CommandItem
              value="close current tab"
              onSelect={() => {
                closeTab(activeTab.id);
                close();
              }}
            >
              <X className="size-3.5" />
              Close current tab
            </CommandItem>
          )}
          {activeId && (
            <>
              <CommandItem
                value="export database"
                onSelect={() => {
                  openExportDialog(activeId);
                  close();
                }}
              >
                <Download className="size-3.5" />
                Export database…
              </CommandItem>
              <CommandItem
                value="import sql file"
                onSelect={() => {
                  openImportDialog(activeId);
                  close();
                }}
              >
                <Upload className="size-3.5" />
                Import SQL file…
              </CommandItem>
            </>
          )}
        </CommandGroup>

        {connections.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Switch connection">
              {connections.map((c) => (
                <CommandItem
                  key={c.id}
                  value={`switch ${c.name} ${c.host} ${c.database}`}
                  onSelect={() => {
                    activate(c.id);
                    close();
                  }}
                >
                  <span>{c.name}</span>
                  <span className="ml-2 text-xs text-muted-foreground">
                    {c.kind} · {c.host}/{c.database}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}
      </CommandList>
    </CommandDialog>
  );
}
