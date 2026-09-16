import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Snippet } from "@/ipc";
import type { Folder } from "@/types";

const ipcMock = {
  listSnippets: vi.fn(),
  listSnippetFolders: vi.fn(),
  reorderSnippets: vi.fn(),
  reorderSnippetFolders: vi.fn(),
  deleteSnippetFolder: vi.fn(),
};

vi.mock("../ipc", () => ({ ipc: ipcMock }));

const { useSnippets } = await import("./snippets");

const snippet = (id: string, over: Partial<Snippet> = {}): Snippet => ({
  id,
  name: id,
  sql: "SELECT 1",
  connection_id: "c1",
  created_at: "",
  bytea_modes_json: null,
  folder_id: null,
  position: null,
  ...over,
});

const folder = (id: string, parent_id: string | null = null): Folder => ({
  id,
  name: id,
  parent_id,
  position: null,
});

describe("useSnippets folder tree", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSnippets.setState({ snippets: [], folders: [], loading: false, loadedFor: null });
  });

  it("moves a snippet into a folder and renumbers the whole container", async () => {
    useSnippets.setState({
      snippets: [snippet("a", { folder_id: "f1", position: 0 }), snippet("b")],
      folders: [folder("f1")],
    });
    ipcMock.reorderSnippets.mockResolvedValue(undefined);

    await useSnippets.getState().moveSnippet("b", "f1", 0);

    expect(ipcMock.reorderSnippets).toHaveBeenCalledWith([
      { id: "b", folder_id: "f1", position: 0 },
      { id: "a", folder_id: "f1", position: 1 },
    ]);
    const byId = new Map(useSnippets.getState().snippets.map((s) => [s.id, s]));
    expect(byId.get("b")?.folder_id).toBe("f1");
    expect(byId.get("b")?.position).toBe(0);
    expect(byId.get("a")?.position).toBe(1);
  });

  it("rolls the optimistic move back when the backend rejects it", async () => {
    useSnippets.setState({ snippets: [snippet("a")], folders: [folder("f1")] });
    ipcMock.reorderSnippets.mockRejectedValue(new Error("boom"));

    await expect(useSnippets.getState().moveSnippet("a", "f1", 0)).rejects.toThrow("boom");
    expect(useSnippets.getState().snippets[0].folder_id).toBeNull();
  });

  it("refuses to drop a folder into its own subtree", async () => {
    useSnippets.setState({ folders: [folder("parent"), folder("child", "parent")] });

    await useSnippets.getState().moveFolder("parent", "child", 0);

    expect(ipcMock.reorderSnippetFolders).not.toHaveBeenCalled();
    expect(useSnippets.getState().folders[0].parent_id).toBeNull();
  });

  it("promotes children to the grandparent when a folder is deleted", async () => {
    useSnippets.setState({
      folders: [folder("top"), folder("mid", "top"), folder("leaf", "mid")],
      snippets: [snippet("a", { folder_id: "mid" })],
    });
    ipcMock.deleteSnippetFolder.mockResolvedValue(undefined);

    await useSnippets.getState().removeFolder("mid");

    const { folders, snippets } = useSnippets.getState();
    expect(folders.map((f) => f.id)).toEqual(["top", "leaf"]);
    expect(folders.find((f) => f.id === "leaf")?.parent_id).toBe("top");
    expect(snippets[0].folder_id).toBe("top");
  });
});
