import { create } from "zustand";
import type { ByteaDisplayMode } from "@/lib/bytea";
import type { DiagramIntrospection, ScriptResult } from "../ipc";
import type { QueryResult } from "../types";
import type { Filter } from "../utils/sql";

let counter = 0;
const newId = (prefix: string) => `${prefix}-${Date.now()}-${++counter}`;

type BaseTab = {
  id: string;
  connectionId: string;
  title: string;
  result: QueryResult | null;
  error: string | null;
  loading: boolean;
};

export type QueryTab = BaseTab & {
  kind: "query";
  sql: string;
  runningQueryId: string | null;
  byteaModes: Record<string, ByteaDisplayMode>;
  snippetId: string | null;
  /** When true, the editor runs as a multi-statement script: SQL is split
   *  client-side and each statement runs on a shared connection. The results
   *  panel switches from a single grid to a per-statement summary list. */
  runAsScript: boolean;
  /** Result of the most recent script run. Mutually exclusive with `result`
   *  in practice — `result` is populated for single-statement runs. */
  scriptResult: ScriptResult | null;
};

export type BrowseTab = BaseTab & {
  kind: "browse";
  schema: string;
  table: string;
  filters: Record<string, Filter>;
  sortCol: string | null;
  sortDir: "asc" | "desc";
  limit: number;
  offset: number;
  pkCols: string[] | null;
  totalRows: number | null;
};

export type DiagramTab = BaseTab & {
  kind: "diagram";
  diagramId: string | null;
  mode: "modeler" | "live";
  introspection: DiagramIntrospection | null;
};

export type ObjectBrowserTab = BaseTab & {
  kind: "objects";
  /** The bucket being browsed. */
  bucket: string;
  /** Current `/`-delimited prefix ("folder"). Empty string is the bucket root. */
  prefix: string;
  /** Currently selected object key, for the preview pane. */
  selectedKey: string | null;
};

export type Tab = QueryTab | BrowseTab | DiagramTab | ObjectBrowserTab;

type State = {
  tabs: Tab[];
  activeTabId: string | null;
};

type Actions = {
  newQueryTab: (
    connectionId: string,
    sql?: string,
    title?: string,
    init?: { byteaModes?: Record<string, ByteaDisplayMode>; snippetId?: string | null },
  ) => string;
  openBrowseTab: (
    connectionId: string,
    schema: string,
    table: string,
    initialFilters?: Record<string, Filter>,
  ) => string;
  openDiagramTab: (connectionId: string) => string;
  openObjectBrowserTab: (connectionId: string, bucket: string) => string;
  closeTab: (id: string) => void;
  closeTabsForConnection: (connectionId: string) => void;
  setActiveTab: (id: string) => void;
  patchTab: (id: string, patch: Partial<Tab>) => void;
};

const defaultSql = "";

export const useTabs = create<State & Actions>((set, get) => ({
  tabs: [],
  activeTabId: null,

  newQueryTab(connectionId, sql = defaultSql, title = "Query", init) {
    const id = newId("tab");
    const tab: QueryTab = {
      id,
      kind: "query",
      connectionId,
      title,
      sql,
      result: null,
      error: null,
      loading: false,
      runningQueryId: null,
      byteaModes: init?.byteaModes ?? {},
      snippetId: init?.snippetId ?? null,
      runAsScript: false,
      scriptResult: null,
    };
    set((s) => ({ tabs: [...s.tabs, tab], activeTabId: id }));
    return id;
  },

  openBrowseTab(connectionId, schema, table, initialFilters): string {
    const existing = get().tabs.find(
      (t): t is BrowseTab =>
        t.kind === "browse" &&
        t.connectionId === connectionId &&
        t.schema === schema &&
        t.table === table,
    );
    if (existing) {
      if (initialFilters && Object.keys(initialFilters).length > 0) {
        set((s) => ({
          tabs: s.tabs.map((t) =>
            t.id === existing.id ? { ...t, filters: { ...initialFilters }, offset: 0 } : t,
          ),
          activeTabId: existing.id,
        }));
      } else {
        set({ activeTabId: existing.id });
      }
      return existing.id;
    }
    const id = newId("tab");
    const tab: BrowseTab = {
      id,
      kind: "browse",
      connectionId,
      title: table,
      schema,
      table,
      filters: initialFilters ? { ...initialFilters } : {},
      sortCol: null,
      sortDir: "asc",
      limit: 100,
      offset: 0,
      result: null,
      error: null,
      loading: false,
      pkCols: null,
      totalRows: null,
    };
    set((s) => ({ tabs: [...s.tabs, tab], activeTabId: id }));
    return id;
  },

  openDiagramTab(connectionId): string {
    // Phase 1: one diagram tab per connection. Reuse the existing one if open.
    const existing = get().tabs.find(
      (t): t is DiagramTab => t.kind === "diagram" && t.connectionId === connectionId,
    );
    if (existing) {
      set({ activeTabId: existing.id });
      return existing.id;
    }
    const id = newId("tab");
    const tab: DiagramTab = {
      id,
      kind: "diagram",
      connectionId,
      title: "Diagram",
      result: null,
      error: null,
      loading: false,
      diagramId: null,
      mode: "modeler",
      introspection: null,
    };
    set((s) => ({ tabs: [...s.tabs, tab], activeTabId: id }));
    return id;
  },

  openObjectBrowserTab(connectionId, bucket): string {
    // One tab per (connection, bucket); reuse if already open.
    const existing = get().tabs.find(
      (t): t is ObjectBrowserTab =>
        t.kind === "objects" && t.connectionId === connectionId && t.bucket === bucket,
    );
    if (existing) {
      set({ activeTabId: existing.id });
      return existing.id;
    }
    const id = newId("tab");
    const tab: ObjectBrowserTab = {
      id,
      kind: "objects",
      connectionId,
      title: bucket,
      bucket,
      prefix: "",
      selectedKey: null,
      result: null,
      error: null,
      loading: false,
    };
    set((s) => ({ tabs: [...s.tabs, tab], activeTabId: id }));
    return id;
  },

  closeTab(id) {
    set((s) => {
      const tabs = s.tabs.filter((t) => t.id !== id);
      const activeTabId =
        s.activeTabId === id ? (tabs[tabs.length - 1]?.id ?? null) : s.activeTabId;
      return { tabs, activeTabId };
    });
  },

  closeTabsForConnection(connectionId) {
    set((s) => {
      const tabs = s.tabs.filter((t) => t.connectionId !== connectionId);
      const activeStillThere = tabs.some((t) => t.id === s.activeTabId);
      const activeTabId = activeStillThere ? s.activeTabId : (tabs[tabs.length - 1]?.id ?? null);
      return { tabs, activeTabId };
    });
  },

  setActiveTab(id) {
    set({ activeTabId: id });
  },

  patchTab(id, patch) {
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? ({ ...t, ...patch } as Tab) : t)),
    }));
  },
}));

export const newQueryId = () => newId("q");
