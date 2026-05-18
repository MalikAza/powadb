import {
  ChevronDown,
  ChevronRight,
  Database,
  Eye,
  Network,
  Plus,
  RefreshCw,
  Search,
  Table2,
  TableProperties,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ipc, type SchemaMeta } from "../ipc";
import { useConnections } from "../stores/connections";
import { useSchema } from "../stores/schema";
import { useTabs } from "../stores/tabs";
import { useUi } from "../stores/ui";
import { ConfirmDialog } from "./ConfirmDialog";

export function SchemaTree() {
  const { activeId, connections } = useConnections();
  const saveConnection = useConnections((s) => s.save);
  const conn = connections.find((c) => c.id === activeId);
  const openBrowseTab = useTabs((s) => s.openBrowseTab);
  const openDiagramTab = useTabs((s) => s.openDiagramTab);
  const setSchemaInStore = useSchema((s) => s.set);
  const setDatabasesInStore = useSchema((s) => s.setDatabases);
  const openSchemas = useUi((s) => s.openSchemas);
  const openTables = useUi((s) => s.openTables);
  const toggleSchema = useUi((s) => s.toggleSchema);
  const toggleTable = useUi((s) => s.toggleTable);
  const setSchemaOpen = useUi((s) => s.setSchemaOpen);
  const schemaSearchFocusToken = useUi((s) => s.schemaSearchFocusToken);

  const [schemas, setSchemas] = useState<SchemaMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [databases, setDatabases] = useState<string[] | null>(null);
  const [databasesOpen, setDatabasesOpen] = useState(false);
  const [createDbOpen, setCreateDbOpen] = useState(false);
  const [createDbName, setCreateDbName] = useState("");
  const [creatingDb, setCreatingDb] = useState(false);
  const [pendingDropDb, setPendingDropDb] = useState<string | null>(null);
  const [droppingDb, setDroppingDb] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const supportsDbAdmin = conn?.kind === "postgres" || conn?.kind === "mysql";

  async function refresh() {
    if (!activeId) return;
    setLoading(true);
    setError(null);
    // The two probes are independent; running them in parallel halves perceived latency
    // and ensures the database list is fetched even when schema introspection fails.
    const [schemaResult, dbResult] = await Promise.allSettled([
      ipc.introspectSchema(activeId),
      ipc.listDatabases(activeId),
    ]);
    if (schemaResult.status === "fulfilled") {
      const result = schemaResult.value;
      setSchemas(result);
      setSchemaInStore(activeId, result);
      if (conn?.kind === "postgres") setSchemaOpen("public", true);
      else if (conn?.kind === "sqlite") setSchemaOpen("main", true);
      else if (result[0]) setSchemaOpen(result[0].name, true);
    } else {
      setError(String(schemaResult.reason));
    }
    if (dbResult.status === "fulfilled") {
      setDatabases(dbResult.value);
      setDatabasesInStore(activeId, dbResult.value);
    } else {
      setDatabases([]);
      setDatabasesInStore(activeId, []);
    }
    setLoading(false);
  }

  useEffect(() => {
    setSchemas(null);
    setError(null);
    setSearch("");
    setDatabases(null);
    setCreateDbOpen(false);
    setCreateDbName("");
    setPendingDropDb(null);
    if (activeId) refresh();
  }, [activeId, conn?.database]);

  async function refreshDatabases() {
    if (!activeId) return;
    try {
      const dbs = await ipc.listDatabases(activeId);
      setDatabases(dbs);
      setDatabasesInStore(activeId, dbs);
    } catch (e) {
      toast.error(`Failed to list databases: ${String(e)}`);
    }
  }

  async function submitCreateDatabase() {
    if (!activeId) return;
    const name = createDbName.trim();
    if (!name) return;
    setCreatingDb(true);
    try {
      await ipc.createDatabase(activeId, name);
      toast.success(`Database "${name}" created`);
      setCreateDbName("");
      setCreateDbOpen(false);
      setDatabasesOpen(true);
      await refreshDatabases();
    } catch (e) {
      toast.error(`Failed to create database: ${String(e)}`);
    } finally {
      setCreatingDb(false);
    }
  }

  async function dropDatabase(db: string) {
    if (!activeId) return;
    setDroppingDb(db);
    try {
      await ipc.dropDatabase(activeId, db);
      toast.success(`Database "${db}" dropped`);
      setPendingDropDb(null);
      await refreshDatabases();
    } catch (e) {
      toast.error(`Failed to drop database: ${String(e)}`);
    } finally {
      setDroppingDb(null);
    }
  }

  function browseTable(schema: string, table: string) {
    if (!activeId) return;
    openBrowseTab(activeId, schema, table);
  }

  async function switchDatabase(db: string) {
    if (!conn || db === conn.database) return;
    try {
      // Carry the tunnel flags across — omitting them defaults the backend
      // to `false`, which would silently disable WG/SSH and wipe their config.
      // The full tunnel payloads (wg_config / ssh_config) are NOT sent: the
      // backend preserves the stored ones when those fields are absent.
      await saveConnection({
        id: conn.id,
        name: conn.name,
        kind: conn.kind,
        host: conn.host,
        port: conn.port,
        database: db,
        username: conn.username,
        ssl: conn.ssl,
        folder_id: conn.folder_id,
        color: conn.color,
        wg_enabled: !!conn.wg,
        ssh_enabled: !!conn.ssh,
      });
      toast.success(`Switched to ${db}`);
    } catch (e) {
      toast.error(`Failed to switch: ${String(e)}`);
    }
  }

  // Filter schemas/tables by search query
  const filteredSchemas = useMemo(() => {
    if (!schemas) return null;
    const q = search.trim().toLowerCase();
    if (!q) return schemas;
    return schemas
      .map((s) => ({
        ...s,
        tables: s.tables.filter(
          (t) => t.name.toLowerCase().includes(q) || s.name.toLowerCase().includes(q),
        ),
      }))
      .filter((s) => s.tables.length > 0);
  }, [schemas, search]);

  // When searching, treat all matching schemas as open
  const effectiveOpenSchemas = useMemo(() => {
    if (!search.trim() || !filteredSchemas) return openSchemas;
    const out = { ...openSchemas };
    for (const s of filteredSchemas) out[s.name] = true;
    return out;
  }, [openSchemas, search, filteredSchemas]);

  useEffect(() => {
    if (schemaSearchFocusToken === 0) return;
    const el = searchInputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, [schemaSearchFocusToken]);

  // Scroll an externally-revealed table into view
  const lastOpenTableKey = useRef<string | null>(null);
  useEffect(() => {
    const openedKeys = Object.entries(openTables)
      .filter(([, v]) => v)
      .map(([k]) => k);
    const newest = openedKeys[openedKeys.length - 1] ?? null;
    if (newest && newest !== lastOpenTableKey.current) {
      const el = document.querySelector(`[data-table-row="${cssEscape(newest)}"]`);
      el?.scrollIntoView({ block: "nearest" });
      lastOpenTableKey.current = newest;
    }
  }, [openTables]);

  if (!activeId) return null;

  return (
    <div className="text-xs">
      {databases && databases.length > 0 && (
        <div className="mb-3">
          <div className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            <button
              type="button"
              onClick={() => setDatabasesOpen((v) => !v)}
              className="flex flex-1 items-center gap-1 rounded px-1 py-0.5 hover:bg-sidebar-accent"
            >
              {databasesOpen ? (
                <ChevronDown className="size-3 shrink-0" />
              ) : (
                <ChevronRight className="size-3 shrink-0" />
              )}
              <span className="flex-1 text-left">Databases</span>
              <span className="text-[10px] normal-case">{databases.length}</span>
            </button>
            {supportsDbAdmin && (
              <Button
                size="icon"
                variant="ghost"
                className="size-5"
                onClick={() => {
                  setDatabasesOpen(true);
                  setCreateDbOpen((v) => !v);
                }}
                title="Create database"
              >
                <Plus className="size-3" />
              </Button>
            )}
          </div>
          {databasesOpen && createDbOpen && supportsDbAdmin && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                submitCreateDatabase();
              }}
              className="mb-1 ml-1 flex items-center gap-1"
            >
              <Input
                autoFocus
                value={createDbName}
                onChange={(e) => setCreateDbName(e.target.value)}
                placeholder="new_database"
                className="h-6 px-1.5 text-[11px]"
              />
              <Button
                type="submit"
                size="sm"
                className="h-6 px-2 text-[11px]"
                disabled={creatingDb || !createDbName.trim()}
              >
                {creatingDb ? "…" : "Create"}
              </Button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="size-6"
                onClick={() => {
                  setCreateDbOpen(false);
                  setCreateDbName("");
                }}
                title="Cancel"
              >
                <X className="size-3" />
              </Button>
            </form>
          )}
          {databasesOpen &&
            databases.map((db) => {
              const isActive = db === conn?.database;
              const isDropping = droppingDb === db;
              return (
                <div
                  key={db}
                  className={`group ml-1 flex w-[calc(100%-0.25rem)] items-center gap-1 rounded ${
                    isActive ? "" : "hover:bg-sidebar-accent"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => switchDatabase(db)}
                    disabled={isActive}
                    title={isActive ? "Current database" : `Switch to ${db}`}
                    className={`flex min-w-0 flex-1 items-center gap-1 rounded px-1 py-0.5 text-left ${
                      isActive ? "cursor-default font-medium text-primary" : "text-foreground"
                    }`}
                  >
                    <Database className="size-3 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">{db}</span>
                  </button>
                  {supportsDbAdmin && !isActive && (
                    <button
                      type="button"
                      onClick={() => setPendingDropDb(db)}
                      disabled={isDropping}
                      title={`Drop ${db}`}
                      className="mr-1 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                    >
                      <Trash2 className="size-3" />
                    </button>
                  )}
                </div>
              );
            })}
        </div>
      )}

      <div className="mb-2 flex items-center justify-between gap-1">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Schema
        </span>
        <div className="flex items-center gap-0.5">
          <Button
            size="icon"
            variant="ghost"
            className="size-6"
            onClick={() => activeId && openDiagramTab(activeId)}
            disabled={!activeId}
            title="Open diagram"
          >
            <Network className="size-3" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="size-6"
            onClick={refresh}
            disabled={loading}
          >
            <RefreshCw className={loading ? "size-3 animate-spin" : "size-3"} />
          </Button>
        </div>
      </div>

      <div className="relative mb-2">
        <Search className="absolute left-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={searchInputRef}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search tables…"
          className="h-7 pl-7 pr-7 text-[11px]"
        />
        {search && (
          <button
            type="button"
            onClick={() => setSearch("")}
            className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="size-3" />
          </button>
        )}
      </div>

      {error && <p className="whitespace-pre-wrap text-destructive">{error}</p>}
      {filteredSchemas?.length === 0 && search && (
        <p className="text-muted-foreground">No tables match.</p>
      )}

      {filteredSchemas?.map((s) => (
        <div key={s.name}>
          <div
            className="flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 font-medium hover:bg-sidebar-accent"
            onClick={() => toggleSchema(s.name)}
          >
            {effectiveOpenSchemas[s.name] ? (
              <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
            )}
            <span className="min-w-0 flex-1 truncate">{s.name}</span>
            <span className="shrink-0 text-[10px] text-muted-foreground">{s.tables.length}</span>
          </div>
          {effectiveOpenSchemas[s.name] &&
            s.tables.map((t) => {
              const key = `${s.name}.${t.name}`;
              const isOpen = openTables[key];
              return (
                <div key={key} className="ml-3" data-table-row={key}>
                  <div
                    className="group flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 hover:bg-sidebar-accent"
                    onClick={() => toggleTable(s.name, t.name)}
                  >
                    {isOpen ? (
                      <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
                    )}
                    {t.kind === "view" ? (
                      <Eye className="size-3 shrink-0 text-muted-foreground" />
                    ) : (
                      <Table2 className="size-3 shrink-0 text-muted-foreground" />
                    )}
                    <span className="min-w-0 flex-1 truncate">{t.name}</span>
                  </div>
                  {isOpen && (
                    <>
                      <button
                        type="button"
                        onClick={() => browseTable(s.name, t.name)}
                        className="mb-0.5 ml-6 flex w-[calc(100%-1.5rem)] items-center gap-1.5 rounded px-1.5 py-1 text-left text-primary hover:bg-primary/15"
                      >
                        <TableProperties className="size-3 shrink-0" />
                        <span className="text-[11px]">Browse data</span>
                      </button>
                      <div className="ml-6">
                        <div className="mb-0.5 px-1.5 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
                          Columns
                        </div>
                        {t.columns.map((c) => (
                          <div
                            key={c.name}
                            className="flex items-center justify-between gap-2 px-1.5 py-0.5 font-mono text-[11px]"
                          >
                            <span className="truncate">
                              {c.name}
                              {!c.nullable && <span className="text-primary"> *</span>}
                            </span>
                            <span className="shrink-0 text-[10px] text-muted-foreground">
                              {c.data_type}
                            </span>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              );
            })}
        </div>
      ))}

      <ConfirmDialog
        open={pendingDropDb !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDropDb(null);
        }}
        title={`Drop database "${pendingDropDb ?? ""}"?`}
        description="This cannot be undone. All tables, views, and data in the database will be lost."
        confirmLabel="Drop"
        onConfirm={() => {
          if (pendingDropDb) dropDatabase(pendingDropDb);
        }}
      />
    </div>
  );
}

function cssEscape(s: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(s);
  return s.replace(/(["\\])/g, "\\$1");
}
