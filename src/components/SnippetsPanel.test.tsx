import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Snippet } from "@/ipc";
import type { Folder } from "@/types";

const ipcMock = {
  listSnippets: vi.fn(),
  saveSnippet: vi.fn(),
  deleteSnippet: vi.fn(),
  reorderSnippets: vi.fn(),
  listSnippetFolders: vi.fn(),
  saveSnippetFolder: vi.fn(),
  reorderSnippetFolders: vi.fn(),
  deleteSnippetFolder: vi.fn(),
};

vi.mock("@/ipc", () => ({ ipc: ipcMock }));
vi.mock("../ipc", () => ({ ipc: ipcMock }));

const { useSnippets } = await import("@/stores/snippets");
const { useConnections } = await import("@/stores/connections");
const { useTabs } = await import("@/stores/tabs");
const { SnippetsPanel } = await import("./SnippetsPanel");

function snippet(over: Partial<Snippet> & Pick<Snippet, "id" | "name">): Snippet {
  return {
    connection_id: "c1",
    sql: "SELECT 1",
    created_at: "",
    bytea_modes_json: null,
    folder_id: null,
    position: null,
    ...over,
  };
}

const SNIPPETS = [
  snippet({ id: "s1", name: "All users", sql: "SELECT * FROM users", folder_id: "f1" }),
  snippet({ id: "s2", name: "Count", sql: "SELECT count(*) FROM orders", folder_id: "f1" }),
  snippet({ id: "s3", name: "Scratch", sql: "SELECT now()" }),
];

const FOLDERS: Folder[] = [
  { id: "f1", name: "reports", parent_id: null, position: null },
  { id: "f2", name: "nested", parent_id: "f1", position: null },
];

/** Renders with "reports" collapsed — expand it to reach s1 / s2. */
async function renderPanel() {
  ipcMock.listSnippets.mockResolvedValue(SNIPPETS);
  ipcMock.listSnippetFolders.mockResolvedValue(FOLDERS);
  await useSnippets.getState().load("c1");
  render(<SnippetsPanel />);
  await screen.findByText("reports");
}

function expandReports() {
  fireEvent.click(screen.getByText("reports"));
}

describe("SnippetsPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSnippets.setState({ snippets: [], folders: [], loading: false, loadedFor: null });
    useConnections.setState({ activeId: "c1" });
    useTabs.setState({ tabs: [], activeTabId: null });
  });

  it("nests snippets under collapsible folders, top-level ones outside", async () => {
    await renderPanel();
    // Collapsed by default: the folder's snippets aren't rendered yet, but the
    // top-level one always is.
    expect(screen.queryByText("All users")).toBeNull();
    expect(screen.getByText("Scratch")).toBeTruthy();

    expandReports();
    expect(screen.getByText("All users")).toBeTruthy();
    expect(screen.getByText("Count")).toBeTruthy();
    // Subfolders render inside their parent.
    expect(screen.getByText("nested")).toBeTruthy();
  });

  it("filters on both name and SQL, revealing hits inside collapsed folders", async () => {
    await renderPanel();
    const search = screen.getByPlaceholderText("Search name or SQL");

    fireEvent.change(search, { target: { value: "scratch" } });
    expect(screen.getByText("Scratch")).toBeTruthy();
    // The folder holds no hit, so the whole branch is pruned.
    expect(screen.queryByText("reports")).toBeNull();

    // "orders" only appears in s2's SQL, never in a name — and s2 lives in a
    // folder that was never expanded.
    fireEvent.change(search, { target: { value: "orders" } });
    expect(screen.getByText("reports")).toBeTruthy();
    expect(screen.getByText("Count")).toBeTruthy();
    expect(screen.queryByText("Scratch")).toBeNull();
  });

  it("renames in place through an upsert carrying the existing id", async () => {
    await renderPanel();
    ipcMock.saveSnippet.mockResolvedValue(SNIPPETS[0]);
    // The tab opened from this snippet should follow the rename.
    let tabId = "";
    act(() => {
      tabId = useTabs
        .getState()
        .newQueryTab("c1", "SELECT * FROM users", "All users", { snippetId: "s1" });
    });

    expandReports();
    fireEvent.contextMenu(screen.getByText("All users"));
    fireEvent.click(await screen.findByText("Rename"));

    const input = await screen.findByDisplayValue("All users");
    fireEvent.change(input, { target: { value: "Every user" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(ipcMock.saveSnippet).toHaveBeenCalled());
    expect(ipcMock.saveSnippet.mock.calls[0][0]).toMatchObject({
      id: "s1",
      name: "Every user",
      sql: "SELECT * FROM users",
      folder_id: "f1",
    });
    expect(useTabs.getState().tabs.find((t) => t.id === tabId)?.title).toBe("Every user");
  });

  it("keeps the rename field open when the closing menu steals focus", async () => {
    await renderPanel();
    expandReports();
    fireEvent.contextMenu(screen.getByText("All users"));
    fireEvent.click(await screen.findByText("Rename"));

    const input = await screen.findByDisplayValue("All users");
    // Radix restoring focus to the trigger row shows up here as a blur.
    fireEvent.blur(input);

    expect(screen.getByDisplayValue("All users")).toBeTruthy();
    expect(ipcMock.saveSnippet).not.toHaveBeenCalled();
  });

  it("opens a snippet in a query tab linked for Cmd+S", async () => {
    await renderPanel();
    act(() => {
      fireEvent.doubleClick(screen.getByText("Scratch"));
    });
    const tab = useTabs.getState().tabs[0];
    expect(tab.kind).toBe("query");
    if (tab.kind !== "query") return;
    expect(tab.snippetId).toBe("s3");
    expect(tab.sql).toBe("SELECT now()");
    // Freshly opened tabs are clean.
    expect(tab.savedSql).toBe("SELECT now()");
  });

  it("saving the active tab as a new snippet adopts it on the tab", async () => {
    await renderPanel();
    let tabId = "";
    act(() => {
      tabId = useTabs.getState().newQueryTab("c1", "SELECT 42", "Query");
    });
    ipcMock.saveSnippet.mockResolvedValue(snippet({ id: "new", name: "Answer" }));

    fireEvent.click(screen.getByTitle("Save current tab as snippet (⌘⇧S)"));
    fireEvent.change(screen.getByPlaceholderText("Snippet name"), {
      target: { value: "Answer" },
    });
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => expect(ipcMock.saveSnippet).toHaveBeenCalled());
    expect(ipcMock.saveSnippet.mock.calls[0][0]).toMatchObject({
      name: "Answer",
      sql: "SELECT 42",
      folder_id: null,
      connection_id: "c1",
    });
    const tab = useTabs.getState().tabs.find((t) => t.id === tabId);
    expect(tab?.kind === "query" && tab.snippetId).toBe("new");
    expect(tab?.kind === "query" && tab.savedSql).toBe("SELECT 42");
  });

  it("does not steal focus back to the name field on every keystroke", async () => {
    await renderPanel();
    act(() => {
      useTabs.getState().newQueryTab("c1", "SELECT 42", "Query");
    });

    fireEvent.click(screen.getByTitle("Save current tab as snippet (⌘⇧S)"));
    const search = screen.getByPlaceholderText("Search name or SQL");
    search.focus();
    fireEvent.change(screen.getByPlaceholderText("Snippet name"), { target: { value: "x" } });

    expect(document.activeElement).toBe(search);
  });

  it("rejects an empty name instead of calling IPC", async () => {
    await renderPanel();
    act(() => {
      useTabs.getState().newQueryTab("c1", "SELECT 42", "Query");
    });

    fireEvent.click(screen.getByTitle("Save current tab as snippet (⌘⇧S)"));
    fireEvent.change(screen.getByPlaceholderText("Snippet name"), { target: { value: "  " } });
    fireEvent.click(screen.getByText("Save"));

    expect(await screen.findByText("Name is required")).toBeTruthy();
    expect(ipcMock.saveSnippet).not.toHaveBeenCalled();
  });
});
