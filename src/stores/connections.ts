import { create } from "zustand";
import { ipc } from "../ipc";
import type { ConnectionInput, Folder, FolderInput, SavedConnection } from "../types";

type State = {
  connections: SavedConnection[];
  folders: Folder[];
  activeId: string | null;
  connectedIds: Set<string>;
  loaded: boolean;
};

type Actions = {
  load: () => Promise<void>;
  save: (input: ConnectionInput) => Promise<SavedConnection>;
  remove: (id: string) => Promise<void>;
  saveFolder: (input: FolderInput) => Promise<Folder>;
  removeFolder: (id: string) => Promise<void>;
  activate: (id: string) => void;
  deactivate: () => void;
  refreshConnected: () => Promise<void>;
  disconnect: (id: string) => Promise<void>;
};

export const useConnections = create<State & Actions>((set, get) => ({
  connections: [],
  folders: [],
  activeId: null,
  connectedIds: new Set(),
  loaded: false,

  async load() {
    const [connections, folders, activeIds] = await Promise.all([
      ipc.listConnections(),
      ipc.listFolders(),
      ipc.listActiveConnections(),
    ]);
    set({ connections, folders, connectedIds: new Set(activeIds), loaded: true });
  },

  async save(input) {
    const saved = await ipc.saveConnection(input);
    await get().load();
    return saved;
  },

  async remove(id) {
    await ipc.deleteConnection(id);
    if (get().activeId === id) set({ activeId: null });
    await get().load();
  },

  async refreshConnected() {
    const ids = await ipc.listActiveConnections();
    set({ connectedIds: new Set(ids) });
  },

  async disconnect(id) {
    await ipc.disconnect(id);
    await get().refreshConnected();
  },

  async saveFolder(input) {
    const saved = await ipc.saveFolder(input);
    await get().load();
    return saved;
  },

  async removeFolder(id) {
    await ipc.deleteFolder(id);
    await get().load();
  },

  activate(id) {
    set({ activeId: id });
  },

  deactivate() {
    set({ activeId: null });
  },
}));
