import { Database, Eye, Play, Plus, TableProperties, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
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
import { useSchema } from "../stores/schema";
import { newQueryId, useTabs } from "../stores/tabs";
import { useUi } from "../stores/ui";

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const { connections, activeId, activate } = useConnections();
  const { tabs, activeTabId, newQueryTab, openBrowseTab, closeTab, patchTab } = useTabs();
  const schemasByConn = useSchema((s) => s.byConnection);
  const revealTable = useUi((s) => s.revealTable);

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

  const tableEntries = useMemo(() => {
    if (!activeId) return [];
    const schemas = schemasByConn[activeId];
    if (!schemas) return [];
    return schemas.flatMap((s) =>
      s.tables.map((t) => ({
        schema: s.name,
        table: t.name,
        kind: t.kind,
      })),
    );
  }, [activeId, schemasByConn]);

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
      <CommandInput placeholder="Type a command, or search a table…" />
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
                if (activeQueryTab.runningQueryId)
                  ipc.cancelQuery(activeQueryTab.runningQueryId);
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
        </CommandGroup>

        {tableEntries.length > 0 && activeId && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Tables">
              {tableEntries.map(({ schema, table, kind }) => {
                const fq = `${schema}.${table}`;
                return (
                  <div key={fq}>
                    <CommandItem
                      value={`browse ${schema} ${table} ${kind}`}
                      onSelect={() => {
                        openBrowseTab(activeId, schema, table);
                        close();
                      }}
                    >
                      <TableProperties className="size-3.5 text-primary" />
                      <span>Browse</span>
                      <span className="font-mono text-foreground">{table}</span>
                      <span className="ml-auto text-xs text-muted-foreground">{schema}</span>
                    </CommandItem>
                    <CommandItem
                      value={`columns schema ${schema} ${table}`}
                      onSelect={() => {
                        revealTable(schema, table);
                        close();
                      }}
                    >
                      {kind === "view" ? (
                        <Eye className="size-3.5 text-muted-foreground" />
                      ) : (
                        <Database className="size-3.5 text-muted-foreground" />
                      )}
                      <span>Show columns of</span>
                      <span className="font-mono text-foreground">{table}</span>
                      <span className="ml-auto text-xs text-muted-foreground">{schema}</span>
                    </CommandItem>
                  </div>
                );
              })}
            </CommandGroup>
          </>
        )}

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
