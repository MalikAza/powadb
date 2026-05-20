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
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { onActivateKey } from "@/lib/a11y";
import { ipc, type SchemaMeta } from "../ipc";
import { useConnections } from "../stores/connections";
import { useSchema } from "../stores/schema";
import { useTabs } from "../stores/tabs";
import { useUi } from "../stores/ui";
import { ConfirmDialog } from "./ConfirmDialog";

type TableMeta = SchemaMeta["tables"][number];

type FetchState = {
  status: "idle" | "loading" | "ready";
  schemas: SchemaMeta[] | null;
  databases: string[] | null;
  error: string | null;
};
type FetchAction =
  | { type: "reset" }
  | { type: "load" }
  | { type: "ready"; schemas?: SchemaMeta[]; databases?: string[]; error?: string }
  | { type: "setDatabases"; databases: string[] };

function fetchReducer(s: FetchState, a: FetchAction): FetchState {
  switch (a.type) {
    case "reset":
      return { status: "idle", schemas: null, databases: null, error: null };
    case "load":
      return { ...s, status: "loading", error: null };
    case "ready":
      return {
        status: "ready",
        schemas: a.schemas ?? s.schemas,
        databases: a.databases ?? s.databases,
        error: a.error ?? null,
      };
    case "setDatabases":
      return { ...s, databases: a.databases };
  }
}

const initialFetchState: FetchState = {
  status: "idle",
  schemas: null,
  databases: null,
  error: null,
};

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

  const [fetch, dispatchFetch] = useReducer(fetchReducer, initialFetchState);
  const schemas = fetch.schemas;
  const databases = fetch.databases;
  const error = fetch.error;
  const loading = fetch.status === "loading";
  const [search, setSearch] = useState("");
  const [dropDb, setDropDb] = useState<{ pending: string | null; busy: string | null }>({
    pending: null,
    busy: null,
  });
  const searchInputRef = useRef<HTMLInputElement>(null);

  const supportsDbAdmin = conn?.kind === "postgres" || conn?.kind === "mysql";

  async function refresh() {
    if (!activeId) return;
    dispatchFetch({ type: "load" });
    // The two probes are independent; running them in parallel halves perceived latency
    // and ensures the database list is fetched even when schema introspection fails.
    const [schemaResult, dbResult] = await Promise.allSettled([
      ipc.introspectSchema(activeId),
      ipc.listDatabases(activeId),
    ]);
    let nextSchemas: SchemaMeta[] | undefined;
    let nextDatabases: string[] | undefined;
    let nextError: string | undefined;
    if (schemaResult.status === "fulfilled") {
      nextSchemas = schemaResult.value;
      setSchemaInStore(activeId, schemaResult.value);
      if (conn?.kind === "postgres") setSchemaOpen("public", true);
      else if (conn?.kind === "sqlite") setSchemaOpen("main", true);
      else if (schemaResult.value[0]) setSchemaOpen(schemaResult.value[0].name, true);
    } else {
      nextError = String(schemaResult.reason);
    }
    if (dbResult.status === "fulfilled") {
      nextDatabases = dbResult.value;
      setDatabasesInStore(activeId, dbResult.value);
    } else {
      nextDatabases = [];
      setDatabasesInStore(activeId, []);
    }
    dispatchFetch({
      type: "ready",
      schemas: nextSchemas,
      databases: nextDatabases,
      error: nextError,
    });
  }

  const resetAll = () => {
    dispatchFetch({ type: "reset" });
    setSearch("");
    setDropDb({ pending: null, busy: null });
  };

  useEffect(() => {
    resetAll();
    if (activeId) refresh();
  }, [activeId, conn?.database]);

  async function refreshDatabases() {
    if (!activeId) return;
    try {
      const dbs = await ipc.listDatabases(activeId);
      dispatchFetch({ type: "setDatabases", databases: dbs });
      setDatabasesInStore(activeId, dbs);
    } catch (e) {
      toast.error(`Failed to list databases: ${String(e)}`);
    }
  }

  async function createDatabase(name: string) {
    if (!activeId) return;
    await ipc.createDatabase(activeId, name);
    toast.success(`Database "${name}" created`);
    await refreshDatabases();
  }

  async function dropDatabase(db: string) {
    if (!activeId) return;
    setDropDb((s) => ({ ...s, busy: db }));
    try {
      await ipc.dropDatabase(activeId, db);
      toast.success(`Database "${db}" dropped`);
      setDropDb({ pending: null, busy: null });
      await refreshDatabases();
    } catch (e) {
      toast.error(`Failed to drop database: ${String(e)}`);
      setDropDb((s) => ({ ...s, busy: null }));
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
    const out: SchemaMeta[] = [];
    for (const s of schemas) {
      const schemaMatches = s.name.toLowerCase().includes(q);
      const tables = [];
      for (const t of s.tables) {
        if (schemaMatches || t.name.toLowerCase().includes(q)) tables.push(t);
      }
      if (tables.length > 0) out.push({ ...s, tables });
    }
    return out;
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
    let newest: string | null = null;
    for (const [k, v] of Object.entries(openTables)) {
      if (v) newest = k;
    }
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
        <DatabasesPanel
          databases={databases}
          activeDatabase={conn?.database}
          supportsDbAdmin={supportsDbAdmin}
          dropBusy={dropDb.busy}
          onSwitch={switchDatabase}
          onRequestDrop={(db) => setDropDb((s) => ({ ...s, pending: db }))}
          onCreate={createDatabase}
        />
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
        <SchemaRow
          key={s.name}
          schema={s}
          isOpen={!!effectiveOpenSchemas[s.name]}
          openTables={openTables}
          onToggleSchema={toggleSchema}
          onToggleTable={toggleTable}
          onBrowse={browseTable}
        />
      ))}

      <ConfirmDialog
        open={dropDb.pending !== null}
        onOpenChange={(open) => {
          if (!open) setDropDb((s) => ({ ...s, pending: null }));
        }}
        title={`Drop database "${dropDb.pending ?? ""}"?`}
        description="This cannot be undone. All tables, views, and data in the database will be lost."
        confirmLabel="Drop"
        onConfirm={() => {
          if (dropDb.pending) dropDatabase(dropDb.pending);
        }}
      />
    </div>
  );
}

function cssEscape(s: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(s);
  return s.replace(/(["\\])/g, "\\$1");
}

type DatabasesPanelProps = {
  databases: string[];
  activeDatabase: string | undefined;
  supportsDbAdmin: boolean;
  dropBusy: string | null;
  onSwitch: (db: string) => void;
  onRequestDrop: (db: string) => void;
  onCreate: (name: string) => Promise<void>;
};

function DatabasesPanel({
  databases,
  activeDatabase,
  supportsDbAdmin,
  dropBusy,
  onSwitch,
  onRequestDrop,
  onCreate,
}: DatabasesPanelProps) {
  const [databasesOpen, setDatabasesOpen] = useState(false);
  const [createDb, setCreateDb] = useState<{ open: boolean; name: string; busy: boolean }>({
    open: false,
    name: "",
    busy: false,
  });
  const createDbInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (createDb.open) createDbInputRef.current?.focus();
  }, [createDb.open]);

  async function submitCreateDatabase() {
    const name = createDb.name.trim();
    if (!name) return;
    setCreateDb((s) => ({ ...s, busy: true }));
    try {
      await onCreate(name);
      setCreateDb({ open: false, name: "", busy: false });
      setDatabasesOpen(true);
    } catch (e) {
      toast.error(`Failed to create database: ${String(e)}`);
      setCreateDb((s) => ({ ...s, busy: false }));
    }
  }

  return (
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
              setCreateDb((s) => ({ ...s, open: !s.open }));
            }}
            title="Create database"
          >
            <Plus className="size-3" />
          </Button>
        )}
      </div>
      {databasesOpen && createDb.open && supportsDbAdmin && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submitCreateDatabase();
          }}
          className="mb-1 ml-1 flex items-center gap-1"
        >
          <Input
            ref={createDbInputRef}
            value={createDb.name}
            onChange={(e) => {
              const value = e.target.value;
              setCreateDb((s) => ({ ...s, name: value }));
            }}
            placeholder="new_database"
            className="h-6 px-1.5 text-[11px]"
          />
          <Button
            type="submit"
            size="sm"
            className="h-6 px-2 text-[11px]"
            disabled={createDb.busy || !createDb.name.trim()}
          >
            {createDb.busy ? "…" : "Create"}
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-6"
            onClick={() => setCreateDb({ open: false, name: "", busy: false })}
            title="Cancel"
          >
            <X className="size-3" />
          </Button>
        </form>
      )}
      {databasesOpen &&
        databases.map((db) => {
          const isActive = db === activeDatabase;
          const isDropping = dropBusy === db;
          return (
            <div
              key={db}
              className={`group ml-1 flex w-[calc(100%-0.25rem)] items-center gap-1 rounded ${
                isActive ? "" : "hover:bg-sidebar-accent"
              }`}
            >
              <button
                type="button"
                onClick={() => onSwitch(db)}
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
                  onClick={() => onRequestDrop(db)}
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
  );
}

type SchemaRowProps = {
  schema: SchemaMeta;
  isOpen: boolean;
  openTables: Record<string, boolean>;
  onToggleSchema: (name: string) => void;
  onToggleTable: (schema: string, table: string) => void;
  onBrowse: (schema: string, table: string) => void;
};

function SchemaRow({
  schema,
  isOpen,
  openTables,
  onToggleSchema,
  onToggleTable,
  onBrowse,
}: SchemaRowProps) {
  return (
    <div>
      <div
        className="flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 font-medium hover:bg-sidebar-accent"
        role="button"
        tabIndex={0}
        onClick={() => onToggleSchema(schema.name)}
        onKeyDown={onActivateKey(() => onToggleSchema(schema.name))}
      >
        {isOpen ? (
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate">{schema.name}</span>
        <span className="shrink-0 text-[10px] text-muted-foreground">{schema.tables.length}</span>
      </div>
      {isOpen &&
        schema.tables.map((t) => {
          const key = `${schema.name}.${t.name}`;
          return (
            <TableNode
              key={key}
              schemaName={schema.name}
              table={t}
              isOpen={!!openTables[key]}
              onToggleTable={onToggleTable}
              onBrowse={onBrowse}
            />
          );
        })}
    </div>
  );
}

type TableNodeProps = {
  schemaName: string;
  table: TableMeta;
  isOpen: boolean;
  onToggleTable: (schema: string, table: string) => void;
  onBrowse: (schema: string, table: string) => void;
};

function TableNode({ schemaName, table, isOpen, onToggleTable, onBrowse }: TableNodeProps) {
  const key = `${schemaName}.${table.name}`;
  return (
    <div className="ml-3" data-table-row={key}>
      <div
        className="group flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 hover:bg-sidebar-accent"
        role="button"
        tabIndex={0}
        onClick={() => onToggleTable(schemaName, table.name)}
        onKeyDown={onActivateKey(() => onToggleTable(schemaName, table.name))}
      >
        {isOpen ? (
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
        )}
        {table.kind === "view" ? (
          <Eye className="size-3 shrink-0 text-muted-foreground" />
        ) : (
          <Table2 className="size-3 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate">{table.name}</span>
      </div>
      {isOpen && (
        <>
          <button
            type="button"
            onClick={() => onBrowse(schemaName, table.name)}
            className="mb-0.5 ml-6 flex w-[calc(100%-1.5rem)] items-center gap-1.5 rounded px-1.5 py-1 text-left text-primary hover:bg-primary/15"
          >
            <TableProperties className="size-3 shrink-0" />
            <span className="text-[11px]">Browse data</span>
          </button>
          <div className="ml-6">
            <div className="mb-0.5 px-1.5 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
              Columns
            </div>
            {table.columns.map((c) => (
              <div
                key={c.name}
                className="flex items-center justify-between gap-2 px-1.5 py-0.5 font-mono text-[11px]"
              >
                <span className="truncate">
                  {c.name}
                  {!c.nullable && <span className="text-primary"> *</span>}
                </span>
                <span className="shrink-0 text-[10px] text-muted-foreground">{c.data_type}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
