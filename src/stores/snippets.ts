import { create } from "zustand";
import type { ByteaDisplayMode } from "@/lib/bytea";
import { ipc, type Snippet, type SnippetInput } from "../ipc";
import type { Folder, FolderInput } from "../types";
import { isSelfOrDescendant } from "../utils/folderTree";
import { computeContainerOrder } from "../utils/reorder";

const VALID_MODES: ReadonlySet<ByteaDisplayMode> = new Set(["hex", "ulid", "uuid"]);

/** Decode `snippets.bytea_modes_json`, dropping anything that isn't a known
 *  display mode. Never throws — a corrupt blob just yields no overrides. */
export function parseByteaModesJson(raw: string | null): Record<string, ByteaDisplayMode> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, ByteaDisplayMode> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string" && VALID_MODES.has(v as ByteaDisplayMode)) {
        out[k] = v as ByteaDisplayMode;
      }
    }
    return out;
  } catch {
    return {};
  }
}

type State = {
  snippets: Snippet[];
  /** Snippet folder tree — same shape and semantics as the connection one. */
  folders: Folder[];
  loading: boolean;
  /** Connection the current list was loaded for, so `reload()` can repeat it. */
  loadedFor: string | null;
};

type Actions = {
  load: (connectionId: string | null) => Promise<void>;
  reload: () => Promise<void>;
  /** Create (no `id`) or update in place (with `id`) — the Rust side upserts. */
  save: (input: SnippetInput) => Promise<Snippet>;
  remove: (id: string) => Promise<void>;
  saveFolder: (input: FolderInput) => Promise<Folder>;
  removeFolder: (id: string) => Promise<void>;
  moveSnippet: (id: string, targetFolderId: string | null, targetIndex: number) => Promise<void>;
  /** No-op when the target container is the folder itself or one of its own
   *  descendants — that drop would orphan the whole branch. */
  moveFolder: (id: string, targetParentId: string | null, targetIndex: number) => Promise<void>;
};

/** Shared because `Cmd+S` must work while the sidebar is on another pane and
 *  `SnippetsPanel` is unmounted. */
export const useSnippets = create<State & Actions>((set, get) => ({
  snippets: [],
  folders: [],
  loading: false,
  loadedFor: null,

  async load(connectionId) {
    set({ loading: true, loadedFor: connectionId });
    try {
      const [snippets, folders] = await Promise.all([
        ipc.listSnippets(connectionId ?? undefined),
        ipc.listSnippetFolders(),
      ]);
      // A newer load() may have landed first; don't clobber it.
      if (get().loadedFor !== connectionId) return;
      set({ snippets, folders, loading: false });
    } catch {
      set({ loading: false });
    }
  },

  reload() {
    return get().load(get().loadedFor);
  },

  async save(input) {
    const saved = await ipc.saveSnippet(input);
    await get().reload();
    return saved;
  },

  async remove(id) {
    await ipc.deleteSnippet(id);
    await get().reload();
  },

  async saveFolder(input) {
    const saved = await ipc.saveSnippetFolder(input);
    set((state) => {
      const idx = state.folders.findIndex((f) => f.id === saved.id);
      return {
        folders: idx === -1 ? [...state.folders, saved] : state.folders.with(idx, saved),
      };
    });
    return saved;
  },

  async removeFolder(id) {
    // Backend promotes children (subfolders + snippets) to the deleted folder's parent.
    const promotedParent = get().folders.find((f) => f.id === id)?.parent_id ?? null;
    await ipc.deleteSnippetFolder(id);
    set((state) => ({
      folders: state.folders
        .filter((f) => f.id !== id)
        .map((f) => (f.parent_id === id ? { ...f, parent_id: promotedParent } : f)),
      snippets: state.snippets.map((s) =>
        s.folder_id === id ? { ...s, folder_id: promotedParent } : s,
      ),
    }));
  },

  async moveSnippet(id, targetFolderId, targetIndex) {
    const prev = get().snippets;
    const moved = prev.find((s) => s.id === id);
    if (!moved) return;
    // Renumber the whole target container (this also freezes the alphabetical
    // fallback order the first time it's dragged in). The source container
    // keeps its positions — gaps are harmless to the comparator.
    const container = prev.filter((s) => s.folder_id === targetFolderId);
    const orderedIds = computeContainerOrder(
      container.concat(moved.folder_id === targetFolderId ? [] : [moved]),
      id,
      targetIndex,
    );
    const updates = orderedIds.map((sid, position) => ({
      id: sid,
      folder_id: targetFolderId,
      position,
    }));
    const byId = new Map(updates.map((u) => [u.id, u]));
    set({
      snippets: prev.map((s) => {
        const u = byId.get(s.id);
        return u ? { ...s, folder_id: u.folder_id, position: u.position } : s;
      }),
    });
    try {
      await ipc.reorderSnippets(updates);
    } catch (e) {
      set({ snippets: prev });
      throw e;
    }
  },

  async moveFolder(id, targetParentId, targetIndex) {
    const prev = get().folders;
    const moved = prev.find((f) => f.id === id);
    if (!moved) return;
    if (targetParentId !== null && isSelfOrDescendant(prev, id, targetParentId)) return;
    const container = prev.filter((f) => f.parent_id === targetParentId);
    const orderedIds = computeContainerOrder(
      container.concat(moved.parent_id === targetParentId ? [] : [moved]),
      id,
      targetIndex,
    );
    const updates = orderedIds.map((fid, position) => ({
      id: fid,
      parent_id: targetParentId,
      position,
    }));
    const byId = new Map(updates.map((u) => [u.id, u]));
    set({
      folders: prev.map((f) => {
        const u = byId.get(f.id);
        return u ? { ...f, parent_id: u.parent_id, position: u.position } : f;
      }),
    });
    try {
      await ipc.reorderSnippetFolders(updates);
    } catch (e) {
      set({ folders: prev });
      throw e;
    }
  },
}));
