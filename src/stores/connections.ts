import { create } from "zustand";
import { ipc } from "../ipc";
import type { ConnectionInput, Folder, FolderInput, SavedConnection } from "../types";
import { useTabs } from "./tabs";

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
    set((state) => {
      const idx = state.connections.findIndex((c) => c.id === saved.id);
      const connections =
        idx === -1
          ? [...state.connections, saved]
          : state.connections.map((c, i) => (i === idx ? saved : c));
      return { connections };
    });
    return saved;
  },

  async remove(id) {
    await ipc.deleteConnection(id);
    set((state) => ({
      connections: state.connections.filter((c) => c.id !== id),
      activeId: state.activeId === id ? null : state.activeId,
    }));
  },

  async refreshConnected() {
    const ids = await ipc.listActiveConnections();
    set({ connectedIds: new Set(ids) });
  },

  async disconnect(id) {
    await ipc.disconnect(id);
    useTabs.getState().closeTabsForConnection(id);
    if (get().activeId === id) set({ activeId: null });
    await get().refreshConnected();
  },

  async saveFolder(input) {
    const saved = await ipc.saveFolder(input);
    set((state) => {
      const idx = state.folders.findIndex((f) => f.id === saved.id);
      const folders =
        idx === -1
          ? [...state.folders, saved]
          : state.folders.map((f, i) => (i === idx ? saved : f));
      return { folders };
    });
    return saved;
  },

  async removeFolder(id) {
    // Backend promotes children (sub-folders + connections) to the deleted folder's parent.
    // Capture that parent before mutating so the optimistic patch matches server behavior.
    const promotedParent = get().folders.find((f) => f.id === id)?.parent_id ?? null;
    await ipc.deleteFolder(id);
    set((state) => ({
      folders: state.folders
        .filter((f) => f.id !== id)
        .map((f) => (f.parent_id === id ? { ...f, parent_id: promotedParent } : f)),
      connections: state.connections.map((c) =>
        c.folder_id === id ? { ...c, folder_id: promotedParent } : c,
      ),
    }));
  },

  activate(id) {
    set({ activeId: id });
  },

  deactivate() {
    set({ activeId: null });
  },
}));
