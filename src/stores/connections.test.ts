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
  prewarmConnection: vi.fn(),
};

vi.mock("../ipc", () => ({
  ipc: ipcMock,
}));

const { useConnections } = await import("./connections");
const { on, _resetForTests } = await import("../lib/events");

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
    ssh: null,
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
  ipcMock.prewarmConnection.mockResolvedValue(undefined);
  _resetForTests();
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

  it("disconnect() emits connection-disconnected, clears matching activeId, and refreshes", async () => {
    useConnections.setState({ activeId: "c1" });
    ipcMock.disconnect.mockResolvedValue(undefined);
    ipcMock.listActiveConnections.mockResolvedValue([]);

    const seen: string[] = [];
    const off = on("connection-disconnected", (id) => seen.push(id));

    await useConnections.getState().disconnect("c1");

    expect(ipcMock.disconnect).toHaveBeenCalledWith("c1");
    expect(seen).toEqual(["c1"]);
    expect(useConnections.getState().activeId).toBeNull();
    expect(useConnections.getState().connectedIds).toEqual(new Set());

    off();
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

  it("activate() prewarms the pool when not yet connected", () => {
    useConnections.setState({ connectedIds: new Set() });
    useConnections.getState().activate("c1");
    expect(ipcMock.prewarmConnection).toHaveBeenCalledWith("c1");
  });

  it("activate() skips prewarming when the pool is already open", () => {
    useConnections.setState({ connectedIds: new Set(["c1"]) });
    useConnections.getState().activate("c1");
    expect(ipcMock.prewarmConnection).not.toHaveBeenCalled();
  });

  it("activate() swallows prewarm failures (errors surface via events)", async () => {
    const err = new Error("nope");
    ipcMock.prewarmConnection.mockRejectedValueOnce(err);
    useConnections.getState().activate("c1");
    await Promise.resolve();
    await Promise.resolve();
    expect(useConnections.getState().activeId).toBe("c1");
  });

  it("save() updates an existing connection by id (no duplicate)", async () => {
    const original = makeConn({ id: "c1", name: "old" });
    useConnections.setState({ connections: [original] });
    const updated = makeConn({ id: "c1", name: "new" });
    ipcMock.saveConnection.mockResolvedValue(updated);

    await useConnections.getState().save({
      id: "c1",
      name: "new",
      kind: "postgres",
      host: "h",
      port: 5432,
      database: "d",
      username: "u",
      ssl: false,
    } as ConnectionInput);

    const conns = useConnections.getState().connections;
    expect(conns).toHaveLength(1);
    expect(conns[0]?.name).toBe("new");
  });

  it("saveFolder() updates an existing folder by id (no duplicate)", async () => {
    useConnections.setState({ folders: [makeFolder("f1", "Old")] });
    const renamed = makeFolder("f1", "Renamed");
    ipcMock.saveFolder.mockResolvedValue(renamed);

    await useConnections.getState().saveFolder({ id: "f1", name: "Renamed" } as FolderInput);

    const folders = useConnections.getState().folders;
    expect(folders).toHaveLength(1);
    expect(folders[0]?.name).toBe("Renamed");
  });

  it("removeFolder() promotes sub-folders and connections to the parent", async () => {
    const root = makeFolder("root", "Root");
    const mid = makeFolder("mid", "Mid", "root");
    const leaf = makeFolder("leaf", "Leaf", "mid");
    const conn = makeConn({ id: "c1", folder_id: "mid" });
    useConnections.setState({
      folders: [root, mid, leaf],
      connections: [conn],
    });
    ipcMock.deleteFolder.mockResolvedValue(undefined);

    await useConnections.getState().removeFolder("mid");

    const s = useConnections.getState();
    expect(s.folders.find((f) => f.id === "mid")).toBeUndefined();
    expect(s.folders.find((f) => f.id === "leaf")?.parent_id).toBe("root");
    expect(s.connections.find((c) => c.id === "c1")?.folder_id).toBe("root");
  });

  it("removeFolder() promotes orphaned children to root when removing a top-level folder", async () => {
    const root = makeFolder("root", "Root");
    const child = makeFolder("child", "Child", "root");
    const conn = makeConn({ id: "c1", folder_id: "root" });
    useConnections.setState({
      folders: [root, child],
      connections: [conn],
    });
    ipcMock.deleteFolder.mockResolvedValue(undefined);

    await useConnections.getState().removeFolder("root");

    const s = useConnections.getState();
    expect(s.folders.find((f) => f.id === "child")?.parent_id).toBeNull();
    expect(s.connections.find((c) => c.id === "c1")?.folder_id).toBeNull();
  });

  it("setConnState() stores a non-idle state for the connection", () => {
    useConnections.getState().setConnState("c1", { kind: "connecting" });
    expect(useConnections.getState().connStates.c1).toEqual({ kind: "connecting" });

    useConnections.getState().setConnState("c1", { kind: "error", message: "boom" });
    expect(useConnections.getState().connStates.c1).toEqual({ kind: "error", message: "boom" });
  });

  it("setConnState() with idle removes the entry from the map", () => {
    useConnections.setState({ connStates: { c1: { kind: "ready" } } });
    useConnections.getState().setConnState("c1", { kind: "idle" });
    expect(useConnections.getState().connStates).toEqual({});
  });

  it("setConnState() with idle is a no-op when the entry is absent", () => {
    const before = useConnections.getState().connStates;
    useConnections.getState().setConnState("missing", { kind: "idle" });
    expect(useConnections.getState().connStates).toBe(before);
  });
});
