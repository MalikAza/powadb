import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionInput, Folder, FolderInput, SavedConnection } from "../types";

const ipcMock = {
  listConnections: vi.fn(),
  listFolders: vi.fn(),
  listActiveConnections: vi.fn(),
  saveConnection: vi.fn(),
  deleteConnection: vi.fn(),
  saveFolder: vi.fn(),
  deleteFolder: vi.fn(),
  disconnect: vi.fn(),
};

vi.mock("../ipc", () => ({
  ipc: ipcMock,
}));

const closeTabsForConnection = vi.fn();
vi.mock("./tabs", () => ({
  useTabs: { getState: () => ({ closeTabsForConnection }) },
}));

const { useConnections } = await import("./connections");

function makeConn(over: Partial<SavedConnection> = {}): SavedConnection {
  return {
    id: over.id ?? "c1",
    name: over.name ?? "c",
    kind: over.kind ?? "postgres",
    host: "h",
    port: 5432,
    database: "d",
    username: "u",
    ssl: false,
    folder_id: over.folder_id ?? null,
    color: over.color ?? null,
    wg: null,
  };
}

function makeFolder(id: string, name: string, parent_id: string | null = null): Folder {
  return { id, name, parent_id };
}

beforeEach(() => {
  useConnections.setState({
    connections: [],
    folders: [],
    activeId: null,
    connectedIds: new Set(),
    loaded: false,
  });
  for (const fn of Object.values(ipcMock)) fn.mockReset();
  closeTabsForConnection.mockReset();
});

describe("useConnections", () => {
  it("load() hydrates state from ipc", async () => {
    const conn = makeConn({ id: "c1" });
    const folder = makeFolder("f1", "Work");
    ipcMock.listConnections.mockResolvedValue([conn]);
    ipcMock.listFolders.mockResolvedValue([folder]);
    ipcMock.listActiveConnections.mockResolvedValue(["c1"]);

    await useConnections.getState().load();
    const s = useConnections.getState();
    expect(s.connections).toEqual([conn]);
    expect(s.folders).toEqual([folder]);
    expect(s.connectedIds).toEqual(new Set(["c1"]));
    expect(s.loaded).toBe(true);
  });

  it("save() forwards the input and reloads", async () => {
    const conn = makeConn({ id: "c2", name: "new" });
    ipcMock.saveConnection.mockResolvedValue(conn);
    ipcMock.listConnections.mockResolvedValue([conn]);
    ipcMock.listFolders.mockResolvedValue([]);
    ipcMock.listActiveConnections.mockResolvedValue([]);

    const input: ConnectionInput = {
      name: "new",
      kind: "postgres",
      host: "h",
      port: 5432,
      database: "d",
      username: "u",
      ssl: false,
    };
    const result = await useConnections.getState().save(input);

    expect(ipcMock.saveConnection).toHaveBeenCalledWith(input);
    expect(result).toEqual(conn);
    expect(useConnections.getState().connections).toEqual([conn]);
  });

  it("remove() clears activeId when it matches and reloads", async () => {
    useConnections.setState({ activeId: "c1" });
    ipcMock.deleteConnection.mockResolvedValue(undefined);
    ipcMock.listConnections.mockResolvedValue([]);
    ipcMock.listFolders.mockResolvedValue([]);
    ipcMock.listActiveConnections.mockResolvedValue([]);

    await useConnections.getState().remove("c1");

    expect(ipcMock.deleteConnection).toHaveBeenCalledWith("c1");
    expect(useConnections.getState().activeId).toBeNull();
  });

  it("remove() keeps activeId when a different connection is deleted", async () => {
    useConnections.setState({ activeId: "keep" });
    ipcMock.deleteConnection.mockResolvedValue(undefined);
    ipcMock.listConnections.mockResolvedValue([]);
    ipcMock.listFolders.mockResolvedValue([]);
    ipcMock.listActiveConnections.mockResolvedValue([]);

    await useConnections.getState().remove("other");
    expect(useConnections.getState().activeId).toBe("keep");
  });

  it("refreshConnected() updates connectedIds in place", async () => {
    ipcMock.listActiveConnections.mockResolvedValue(["a", "b"]);
    await useConnections.getState().refreshConnected();
    expect(useConnections.getState().connectedIds).toEqual(new Set(["a", "b"]));
  });

  it("disconnect() closes tabs, clears matching activeId, and refreshes", async () => {
    useConnections.setState({ activeId: "c1" });
    ipcMock.disconnect.mockResolvedValue(undefined);
    ipcMock.listActiveConnections.mockResolvedValue([]);

    await useConnections.getState().disconnect("c1");

    expect(ipcMock.disconnect).toHaveBeenCalledWith("c1");
    expect(closeTabsForConnection).toHaveBeenCalledWith("c1");
    expect(useConnections.getState().activeId).toBeNull();
    expect(useConnections.getState().connectedIds).toEqual(new Set());
  });

  it("disconnect() preserves activeId when a different connection disconnects", async () => {
    useConnections.setState({ activeId: "keep" });
    ipcMock.disconnect.mockResolvedValue(undefined);
    ipcMock.listActiveConnections.mockResolvedValue([]);

    await useConnections.getState().disconnect("other");
    expect(useConnections.getState().activeId).toBe("keep");
  });

  it("saveFolder() forwards input and reloads", async () => {
    const folder = makeFolder("f1", "Work");
    ipcMock.saveFolder.mockResolvedValue(folder);
    ipcMock.listConnections.mockResolvedValue([]);
    ipcMock.listFolders.mockResolvedValue([folder]);
    ipcMock.listActiveConnections.mockResolvedValue([]);

    const input: FolderInput = { name: "Work" };
    const result = await useConnections.getState().saveFolder(input);
    expect(ipcMock.saveFolder).toHaveBeenCalledWith(input);
    expect(result).toEqual(folder);
    expect(useConnections.getState().folders).toEqual([folder]);
  });

  it("removeFolder() calls ipc and reloads", async () => {
    ipcMock.deleteFolder.mockResolvedValue(undefined);
    ipcMock.listConnections.mockResolvedValue([]);
    ipcMock.listFolders.mockResolvedValue([]);
    ipcMock.listActiveConnections.mockResolvedValue([]);

    await useConnections.getState().removeFolder("f1");
    expect(ipcMock.deleteFolder).toHaveBeenCalledWith("f1");
  });

  it("activate() and deactivate() set and clear activeId", () => {
    useConnections.getState().activate("c1");
    expect(useConnections.getState().activeId).toBe("c1");
    useConnections.getState().deactivate();
    expect(useConnections.getState().activeId).toBeNull();
  });
});
