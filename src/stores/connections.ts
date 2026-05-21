import { create } from "zustand";
import type { Capabilities } from "../ipc";
import { ipc } from "../ipc";
import type { ConnectionInput, Folder, FolderInput, SavedConnection } from "../types";
import { useTabs } from "./tabs";

export type ConnState =
  | { kind: "idle" }
  | { kind: "connecting" }
  | { kind: "ready" }
  | { kind: "error"; message: string };

type State = {
  connections: SavedConnection[];
  folders: Folder[];
  activeId: string | null;
  connectedIds: Set<string>;
  /// Per-connection state machine driven by `connection-state-changed` events.
  /// Absence from the map == idle.
  connStates: Record<string, ConnState>;
  /// Per-connection capability flags, fetched lazily once the pool is ready.
  /// Absence from the map == not yet fetched; presence == we know what the
  /// engine supports and can gate UI accordingly.
  capabilities: Record<string, Capabilities>;
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
  setConnState: (id: string, state: ConnState) => void;
};

export const useConnections = create<State & Actions>((set, get) => ({
  connections: [],
  folders: [],
  activeId: null,
  connectedIds: new Set(),
  connStates: {},
  capabilities: {},
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
    set((state) => {
      const folders: typeof state.folders = [];
      for (const f of state.folders) {
        if (f.id === id) continue;
        folders.push(f.parent_id === id ? { ...f, parent_id: promotedParent } : f);
      }
      return {
        folders,
        connections: state.connections.map((c) =>
          c.folder_id === id ? { ...c, folder_id: promotedParent } : c,
        ),
      };
    });
  },

  activate(id) {
    set({ activeId: id });
    // Eagerly open the tunnel/pool so the SchemaTree never has to. Putting the
    // trigger here (rather than in a SchemaTree effect on `idle` state) means
    // a post-disconnect `idle` event can't accidentally re-open the pool the
    // user just closed.
    if (!get().connectedIds.has(id)) {
      ipc.prewarmConnection(id).catch(() => {
        // Failures surface via the `connection-state-changed` Error event.
      });
    }
  },

  deactivate() {
    set({ activeId: null });
  },

  setConnState(id, state) {
    set((s) => {
      if (state.kind === "idle") {
        if (!(id in s.connStates)) return s;
        const next = { ...s.connStates };
        delete next[id];
        // Drop capabilities too so a future reconnect re-fetches them.
        const nextCaps = { ...s.capabilities };
        delete nextCaps[id];
        return { connStates: next, capabilities: nextCaps };
      }
      return { connStates: { ...s.connStates, [id]: state } };
    });
    // When a pool becomes ready, fetch capabilities once so feature gating
    // is in place before the UI tries to render engine-specific bits.
    if (state.kind === "ready" && !(id in get().capabilities)) {
      ipc
        .getCapabilities(id)
        .then((caps) => {
          set((s) => ({ capabilities: { ...s.capabilities, [id]: caps } }));
        })
        .catch(() => {
          // Capability fetch failures are non-fatal — the UI will fall back to
          // attempting features and surfacing whatever error the backend
          // returns. The next reconnect will retry.
        });
    }
  },
}));
