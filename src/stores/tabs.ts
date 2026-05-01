import { create } from "zustand";
import type { QueryResult } from "../types";

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
};

export type BrowseTab = BaseTab & {
  kind: "browse";
  schema: string;
  table: string;
  filters: Record<string, string>;
  sortCol: string | null;
  sortDir: "asc" | "desc";
  limit: number;
  offset: number;
  pkCols: string[] | null;
  totalRows: number | null;
};

export type Tab = QueryTab | BrowseTab;

type State = {
  tabs: Tab[];
  activeTabId: string | null;
};

type Actions = {
  newQueryTab: (connectionId: string, sql?: string) => string;
  openBrowseTab: (connectionId: string, schema: string, table: string) => string;
  closeTab: (id: string) => void;
  setActiveTab: (id: string) => void;
  patchTab: (id: string, patch: Partial<Tab>) => void;
};

const defaultSql = "SELECT 1;";

export const useTabs = create<State & Actions>((set, get) => ({
  tabs: [],
  activeTabId: null,

  newQueryTab(connectionId, sql = defaultSql) {
    const id = newId("tab");
    const tab: QueryTab = {
      id,
      kind: "query",
      connectionId,
      title: "Query",
      sql,
      result: null,
      error: null,
      loading: false,
      runningQueryId: null,
    };
    set((s) => ({ tabs: [...s.tabs, tab], activeTabId: id }));
    return id;
  },

  openBrowseTab(connectionId, schema, table): string {
    const existing = get().tabs.find(
      (t): t is BrowseTab =>
        t.kind === "browse" &&
        t.connectionId === connectionId &&
        t.schema === schema &&
        t.table === table,
    );
    if (existing) {
      set({ activeTabId: existing.id });
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
      filters: {},
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

  closeTab(id) {
    set((s) => {
      const tabs = s.tabs.filter((t) => t.id !== id);
      const activeTabId =
        s.activeTabId === id ? (tabs[tabs.length - 1]?.id ?? null) : s.activeTabId;
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
