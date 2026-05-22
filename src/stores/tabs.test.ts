import { beforeEach, describe, expect, it } from "vitest";
import { newQueryId, useTabs } from "./tabs";

function reset() {
  useTabs.setState({ tabs: [], activeTabId: null });
}

describe("useTabs", () => {
  beforeEach(reset);

  it("creates a new query tab empty by default and activates it", () => {
    const id = useTabs.getState().newQueryTab("c1");
    const s = useTabs.getState();
    expect(s.tabs).toHaveLength(1);
    expect(s.activeTabId).toBe(id);
    const tab = s.tabs[0];
    expect(tab.kind).toBe("query");
    expect(tab.connectionId).toBe("c1");
    if (tab.kind === "query") {
      expect(tab.sql).toBe("");
      expect(tab.runningQueryId).toBeNull();
    }
  });

  it("creates a query tab with custom SQL", () => {
    const id = useTabs.getState().newQueryTab("c1", "SELECT 42");
    const tab = useTabs.getState().tabs.find((t) => t.id === id);
    if (tab?.kind === "query") expect(tab.sql).toBe("SELECT 42");
    else throw new Error("expected query tab");
  });

  it("opens a browse tab with default pagination state", () => {
    const id = useTabs.getState().openBrowseTab("c1", "public", "users");
    const s = useTabs.getState();
    expect(s.activeTabId).toBe(id);
    const tab = s.tabs[0];
    if (tab?.kind === "browse") {
      expect(tab.schema).toBe("public");
      expect(tab.table).toBe("users");
      expect(tab.limit).toBe(100);
      expect(tab.offset).toBe(0);
      expect(tab.sortDir).toBe("asc");
      expect(tab.filters).toEqual({});
    } else {
      throw new Error("expected browse tab");
    }
  });

  it("reuses an existing browse tab instead of duplicating it", () => {
    const id1 = useTabs.getState().openBrowseTab("c1", "public", "users");
    useTabs.getState().newQueryTab("c1");
    const id2 = useTabs.getState().openBrowseTab("c1", "public", "users");
    expect(id1).toBe(id2);
    expect(useTabs.getState().tabs.filter((t) => t.kind === "browse")).toHaveLength(1);
    expect(useTabs.getState().activeTabId).toBe(id1);
  });

  it("does not dedupe browse tabs across connections or different tables", () => {
    const a = useTabs.getState().openBrowseTab("c1", "public", "users");
    const b = useTabs.getState().openBrowseTab("c2", "public", "users");
    const c = useTabs.getState().openBrowseTab("c1", "public", "orders");
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it("closes a tab and selects the last remaining one when the active is removed", () => {
    const t1 = useTabs.getState().newQueryTab("c1");
    const t2 = useTabs.getState().newQueryTab("c1");
    expect(useTabs.getState().activeTabId).toBe(t2);
    useTabs.getState().closeTab(t2);
    expect(useTabs.getState().activeTabId).toBe(t1);
    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual([t1]);
  });

  it("keeps the active tab when closing a different one", () => {
    const t1 = useTabs.getState().newQueryTab("c1");
    const t2 = useTabs.getState().newQueryTab("c1");
    useTabs.getState().closeTab(t1);
    expect(useTabs.getState().activeTabId).toBe(t2);
  });

  it("sets activeTabId to null when the last tab is closed", () => {
    const id = useTabs.getState().newQueryTab("c1");
    useTabs.getState().closeTab(id);
    expect(useTabs.getState().activeTabId).toBeNull();
    expect(useTabs.getState().tabs).toEqual([]);
  });

  it("closeTabsForConnection removes only that connection's tabs", () => {
    useTabs.getState().newQueryTab("c1");
    useTabs.getState().newQueryTab("c1");
    const keep = useTabs.getState().newQueryTab("c2");
    useTabs.getState().closeTabsForConnection("c1");
    const s = useTabs.getState();
    expect(s.tabs.map((t) => t.id)).toEqual([keep]);
    expect(s.activeTabId).toBe(keep);
  });

  it("closeTabsForConnection nulls activeTabId when nothing remains", () => {
    useTabs.getState().newQueryTab("c1");
    useTabs.getState().closeTabsForConnection("c1");
    expect(useTabs.getState().activeTabId).toBeNull();
  });

  it("closeTabsForConnection preserves activeTabId when it survives", () => {
    const c1 = useTabs.getState().newQueryTab("c1");
    const c2 = useTabs.getState().newQueryTab("c2");
    useTabs.getState().setActiveTab(c2);
    useTabs.getState().closeTabsForConnection("c1");
    expect(useTabs.getState().activeTabId).toBe(c2);
    expect(useTabs.getState().tabs.find((t) => t.id === c1)).toBeUndefined();
  });

  it("setActiveTab updates the active id", () => {
    const t1 = useTabs.getState().newQueryTab("c1");
    const t2 = useTabs.getState().newQueryTab("c1");
    useTabs.getState().setActiveTab(t1);
    expect(useTabs.getState().activeTabId).toBe(t1);
    useTabs.getState().setActiveTab(t2);
    expect(useTabs.getState().activeTabId).toBe(t2);
  });

  it("patchTab merges fields on the matching tab only", () => {
    const t1 = useTabs.getState().newQueryTab("c1");
    const t2 = useTabs.getState().newQueryTab("c1");
    useTabs.getState().patchTab(t1, { title: "renamed", loading: true });
    const tabs = useTabs.getState().tabs;
    expect(tabs.find((t) => t.id === t1)?.title).toBe("renamed");
    expect(tabs.find((t) => t.id === t1)?.loading).toBe(true);
    expect(tabs.find((t) => t.id === t2)?.title).toBe("Query");
  });
});

describe("useTabs — openBrowseTab filter overrides", () => {
  beforeEach(reset);

  it("merges new filters into an existing browse tab and resets offset", () => {
    const id = useTabs.getState().openBrowseTab("c1", "public", "users");
    useTabs.getState().patchTab(id, { offset: 200 });
    const reopened = useTabs.getState().openBrowseTab("c1", "public", "users", {
      status: { kind: "compare", op: "=", value: "active" },
    });
    expect(reopened).toBe(id);
    const tab = useTabs.getState().tabs.find((t) => t.id === id);
    if (tab?.kind !== "browse") throw new Error("expected browse tab");
    expect(tab.filters).toEqual({ status: { kind: "compare", op: "=", value: "active" } });
    expect(tab.offset).toBe(0);
  });

  it("keeps the existing filters when reopening with no overrides", () => {
    const id = useTabs.getState().openBrowseTab("c1", "public", "users", {
      role: { kind: "compare", op: "=", value: "admin" },
    });
    useTabs.getState().openBrowseTab("c1", "public", "users");
    const tab = useTabs.getState().tabs.find((t) => t.id === id);
    if (tab?.kind !== "browse") throw new Error("expected browse tab");
    expect(tab.filters).toEqual({ role: { kind: "compare", op: "=", value: "admin" } });
  });
});

describe("useTabs — openDiagramTab", () => {
  beforeEach(reset);

  it("creates a single diagram tab per connection with default state", () => {
    const id = useTabs.getState().openDiagramTab("c1");
    const tab = useTabs.getState().tabs.find((t) => t.id === id);
    if (tab?.kind !== "diagram") throw new Error("expected diagram tab");
    expect(tab.connectionId).toBe("c1");
    expect(tab.title).toBe("Diagram");
    expect(tab.mode).toBe("modeler");
    expect(tab.diagramId).toBeNull();
    expect(tab.introspection).toBeNull();
    expect(useTabs.getState().activeTabId).toBe(id);
  });

  it("reuses an existing diagram tab for the same connection", () => {
    const id1 = useTabs.getState().openDiagramTab("c1");
    useTabs.getState().newQueryTab("c1");
    const id2 = useTabs.getState().openDiagramTab("c1");
    expect(id2).toBe(id1);
    expect(useTabs.getState().tabs.filter((t) => t.kind === "diagram")).toHaveLength(1);
    expect(useTabs.getState().activeTabId).toBe(id1);
  });

  it("creates separate diagram tabs per connection", () => {
    const a = useTabs.getState().openDiagramTab("c1");
    const b = useTabs.getState().openDiagramTab("c2");
    expect(a).not.toBe(b);
    expect(useTabs.getState().tabs.filter((t) => t.kind === "diagram")).toHaveLength(2);
  });
});

describe("newQueryId", () => {
  it("returns a unique id on every call", () => {
    const ids = new Set([newQueryId(), newQueryId(), newQueryId()]);
    expect(ids.size).toBe(3);
  });

  it("uses a 'q-' prefix", () => {
    expect(newQueryId()).toMatch(/^q-/);
  });
});
