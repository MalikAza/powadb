import { Database, Download, Play, Plus, Unplug, Upload, X } from "lucide-react";
import { toast } from "sonner";
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

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function CommandPalette({ open, onOpenChange }: Props) {
  const { connections, activeId, activate, connectedIds, disconnect, save } = useConnections();
  const { tabs, activeTabId, newQueryTab, closeTab, patchTab } = useTabs();
  const openExportDialog = useUi((s) => s.openExportDialog);
  const openImportDialog = useUi((s) => s.openImportDialog);
  const databasesByConnection = useSchema((s) => s.databasesByConnection);
  const activeConn = activeId ? (connections.find((c) => c.id === activeId) ?? null) : null;
  const switchable = activeConn ? (databasesByConnection[activeConn.id] ?? []) : [];

  const activeTab = tabs.find((t) => t.id === activeTabId);
  const activeQueryTab = activeTab?.kind === "query" ? activeTab : null;

  const connectedList = connections.filter((c) => connectedIds.has(c.id));
  const activeConnected =
    activeId && connectedIds.has(activeId)
      ? (connections.find((c) => c.id === activeId) ?? null)
      : null;
  const otherConnected = connectedList.filter((c) => c.id !== activeId);

  function close() {
    onOpenChange(false);
  }

  async function switchDatabase(db: string) {
    if (!activeConn || db === activeConn.database) return;
    try {
      // Preserve tunnel flags — see SchemaTree.tsx for the same caveat.
      await save({
        id: activeConn.id,
        name: activeConn.name,
        kind: activeConn.kind,
        host: activeConn.host,
        port: activeConn.port,
        database: db,
        username: activeConn.username,
        ssl: activeConn.ssl,
        folder_id: activeConn.folder_id,
        color: activeConn.color,
        wg_enabled: !!activeConn.wg,
        ssh_enabled: !!activeConn.ssh,
      });
      toast.success(`Switched to ${db}`);
    } catch (e) {
      toast.error(`Failed to switch: ${String(e)}`);
    }
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
    <CommandDialog open={open} onOpenChange={onOpenChange}>
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

        {connectedList.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Disconnect">
              {activeConnected && (
                <CommandItem
                  value={`disconnect current ${activeConnected.name}`}
                  onSelect={() => {
                    disconnect(activeConnected.id);
                    close();
                  }}
                >
                  <Unplug className="size-3.5" />
                  Disconnect current connection
                  <span className="ml-2 text-xs text-muted-foreground">{activeConnected.name}</span>
                </CommandItem>
              )}
              {otherConnected.map((c) => (
                <CommandItem
                  key={c.id}
                  value={`disconnect ${c.name} ${c.host} ${c.database}`}
                  onSelect={() => {
                    disconnect(c.id);
                    close();
                  }}
                >
                  <Unplug className="size-3.5" />
                  <span>Disconnect {c.name}</span>
                  <span className="ml-2 text-xs text-muted-foreground">
                    {c.kind} · {c.host}/{c.database}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {activeConn && switchable.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Switch database">
              {switchable.map((db) => {
                const isActive = db === activeConn.database;
                return (
                  <CommandItem
                    key={db}
                    value={`switch db ${db}`}
                    disabled={isActive}
                    onSelect={() => {
                      switchDatabase(db);
                      close();
                    }}
                  >
                    <Database className="size-3.5" />
                    <span>{db}</span>
                    {isActive && (
                      <span className="ml-2 text-xs text-muted-foreground">current</span>
                    )}
                  </CommandItem>
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
                  {c.color && (
                    <span
                      aria-hidden
                      className="inline-block size-2.5 rounded-full"
                      style={{ backgroundColor: c.color }}
                    />
                  )}
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
