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
import { type Dispatch, useEffect, useMemo, useReducer, useRef, useState } from "react";
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
import { S3BucketTree } from "./S3BucketTree";

type TableMeta = SchemaMeta["tables"][number];
type Conn = ReturnType<typeof useConnections.getState>["connections"][number];
type ConnState = { kind: "idle" | "connecting" | "ready" } | { kind: "error"; message: string };

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

function useDatabaseActions(
  activeId: string | null,
  conn: Conn | undefined,
  dispatchFetch: Dispatch<FetchAction>,
) {
  const setDatabasesInStore = useSchema((s) => s.setDatabases);
  const switchDatabaseAction = useConnections((s) => s.switchDatabase);
  const [dropDb, setDropDb] = useState<{ pending: string | null; busy: string | null }>({
    pending: null,
    busy: null,
  });

  useEffect(() => {
    setDropDb({ pending: null, busy: null });
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

  async function switchDatabase(db: string) {
    if (!conn || db === conn.database) return;
    try {
      await switchDatabaseAction(conn.id, db);
      toast.success(`Switched to ${db}`);
    } catch (e) {
      toast.error(`Failed to switch: ${String(e)}`);
    }
  }

  return { dropDb, setDropDb, createDatabase, dropDatabase, switchDatabase };
}

type SchemaToolbarProps = {
  loading: boolean;
  onRefresh: () => void;
  onOpenDiagram: (() => void) | null;
};

function SchemaToolbar({ loading, onRefresh, onOpenDiagram }: SchemaToolbarProps) {
  return (
    <div className="mb-2 flex items-center justify-between gap-1">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        Schema
      </span>
      <div className="flex items-center gap-0.5">
        <Button
          size="icon"
          variant="ghost"
          className="size-6"
          onClick={() => onOpenDiagram?.()}
          disabled={!onOpenDiagram}
          title="Open diagram"
        >
          <Network className="size-3" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="size-6"
          onClick={onRefresh}
          disabled={loading}
        >
          <RefreshCw className={loading ? "size-3 animate-spin" : "size-3"} />
        </Button>
      </div>
    </div>
  );
}

type SchemaSearchInputProps = {
  value: string;
  onChange: (next: string) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
};

function SchemaSearchInput({ value, onChange, inputRef }: SchemaSearchInputProps) {
  return (
    <div className="relative mb-2">
      <Search className="absolute left-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
      <Input
        ref={inputRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search tables…"
        className="h-7 pl-7 pr-7 text-[11px]"
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange("")}
          className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="size-3" />
        </button>
      )}
    </div>
  );
}

type ConnectionStatusViewProps = {
  connState: ConnState;
  conn: Conn | undefined;
  hasSchemas: boolean;
  error: string | null;
  noMatch: boolean;
  onRetry: () => void;
};

function ConnectionStatusView({
  connState,
  conn,
  hasSchemas,
  error,
  noMatch,
  onRetry,
}: ConnectionStatusViewProps) {
  if ((connState.kind === "connecting" || connState.kind === "idle") && !hasSchemas) {
    const label = conn?.ssh
      ? "Connecting via SSH…"
      : conn?.wg
        ? "Connecting via WireGuard…"
        : "Connecting…";
    return (
      <p className="flex items-center gap-2 text-muted-foreground">
        <RefreshCw className="size-3 animate-spin" />
        <span>{label}</span>
      </p>
    );
  }
  if (connState.kind === "error") {
    return (
      <div className="space-y-1">
        <p className="whitespace-pre-wrap text-destructive">{connState.message}</p>
        <Button size="sm" variant="outline" className="h-6 text-[11px]" onClick={onRetry}>
          Retry
        </Button>
      </div>
    );
  }
  if (error && connState.kind === "ready") {
    return <p className="whitespace-pre-wrap text-destructive">{error}</p>;
  }
  if (noMatch) return <p className="text-muted-foreground">No tables match.</p>;
  return null;
}

export function SchemaTree() {
  const { activeId, connections } = useConnections();
  const connStates = useConnections((s) => s.connStates);
  const conn = connections.find((c) => c.id === activeId);
  const connState: ConnState = activeId
    ? (connStates[activeId] ?? { kind: "idle" })
    : { kind: "idle" };
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
  const { schemas, databases, error, status } = fetch;
  const loading = status === "loading";
  const [search, setSearch] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);

  const { dropDb, setDropDb, createDatabase, dropDatabase, switchDatabase } = useDatabaseActions(
    activeId,
    conn,
    dispatchFetch,
  );

  // Prefer capability flags (populated once the pool is ready) over
  // hard-coded kind checks so new engines (Mongo, …) work without touching
  // this component. Fall back to the kind check until capabilities arrive.
  const caps = useConnections((s) => (activeId ? s.capabilities[activeId] : undefined));
  const supportsDbCreate = caps
    ? caps.supports_databases_list && caps.supports_database_create
    : conn?.kind === "postgres" || conn?.kind === "mysql";
  const supportsDbDrop = caps
    ? caps.supports_databases_list && caps.supports_database_drop
    : conn?.kind === "postgres" || conn?.kind === "mysql";

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

  useEffect(() => {
    dispatchFetch({ type: "reset" });
    setSearch("");
  }, [activeId, conn?.database]);

  // Kick the actual schema/db introspection only once the backend reports the
  // tunnel + pool are ready. This avoids painting an error string while SSH /
  // WireGuard is still negotiating; the UI sticks on the "Connecting…"
  // placeholder until the connection settles. The connection itself is opened
  // by `useConnections.activate` — auto-firing prewarm on `idle` here would
  // re-open a pool the user just disconnected.
  useEffect(() => {
    if (!activeId) return;
    // S3 has no SQL schema/database introspection; the bucket tree fetches
    // its own data. Skip the SQL probes so they don't error against it.
    if (conn?.kind === "s3") return;
    if (connState.kind === "ready") refresh();
  }, [activeId, connState.kind, conn?.database, conn?.kind]);

  function browseTable(schema: string, table: string) {
    if (!activeId) return;
    openBrowseTab(activeId, schema, table);
  }

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

  // S3 connections have no SQL schema; show a bucket tree instead.
  if (conn?.kind === "s3") {
    return <S3BucketTree connectionId={activeId} connState={connState} />;
  }

  return (
    <div className="text-xs">
      {databases && databases.length > 0 && (
        <DatabasesPanel
          databases={databases}
          activeDatabase={conn?.database}
          supportsDbCreate={supportsDbCreate}
          supportsDbDrop={supportsDbDrop}
          dropBusy={dropDb.busy}
          onSwitch={switchDatabase}
          onRequestDrop={(db) => setDropDb((s) => ({ ...s, pending: db }))}
          onCreate={createDatabase}
        />
      )}

      <SchemaToolbar
        loading={loading}
        onRefresh={refresh}
        onOpenDiagram={() => openDiagramTab(activeId)}
      />
      <SchemaSearchInput value={search} onChange={setSearch} inputRef={searchInputRef} />
      <ConnectionStatusView
        connState={connState}
        conn={conn}
        hasSchemas={!!schemas}
        error={error}
        noMatch={filteredSchemas?.length === 0 && !!search}
        onRetry={() => ipc.prewarmConnection(activeId).catch(() => {})}
      />

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
  supportsDbCreate: boolean;
  supportsDbDrop: boolean;
  dropBusy: string | null;
  onSwitch: (db: string) => void;
  onRequestDrop: (db: string) => void;
  onCreate: (name: string) => Promise<void>;
};

function DatabasesPanel({
  databases,
  activeDatabase,
  supportsDbCreate,
  supportsDbDrop,
  dropBusy,
  onSwitch,
  onRequestDrop,
  onCreate,
}: DatabasesPanelProps) {
  const databasesOpen = useUi((s) => s.databasesOpen);
  const toggleDatabases = useUi((s) => s.toggleDatabases);
  const setDatabasesOpen = useUi((s) => s.setDatabasesOpen);
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
          onClick={toggleDatabases}
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
        {supportsDbCreate && (
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
      {databasesOpen && createDb.open && supportsDbCreate && (
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
              {supportsDbDrop && !isActive && (
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
