import type { Folder, SavedConnection } from "../types";

/// Sidebar ordering within a container: manually positioned items first (by
/// `position`), then never-dragged items (`position === null`) alphabetically.
/// Shared by the tree below and the drag-and-drop order computation.
export function byPositionThenName(
  a: { name: string; position: number | null },
  b: { name: string; position: number | null },
): number {
  if (a.position !== null && b.position !== null) return a.position - b.position;
  if (a.position !== null) return -1;
  if (b.position !== null) return 1;
  return a.name.localeCompare(b.name);
}

export type FolderNode = {
  folder: Folder;
  children: FolderNode[];
  connections: SavedConnection[];
};

export type Tree = {
  rootFolders: FolderNode[];
  rootConnections: SavedConnection[];
};

export function buildTree(folders: Folder[], connections: SavedConnection[]): Tree {
  const nodeById: Record<string, FolderNode> = {};
  for (const f of folders) {
    nodeById[f.id] = { folder: f, children: [], connections: [] };
  }

  const rootFolders: FolderNode[] = [];
  for (const f of folders) {
    const node = nodeById[f.id];
    if (f.parent_id && nodeById[f.parent_id]) {
      nodeById[f.parent_id].children.push(node);
    } else {
      rootFolders.push(node);
    }
  }

  const rootConnections: SavedConnection[] = [];
  for (const c of connections) {
    if (c.folder_id && nodeById[c.folder_id]) {
      nodeById[c.folder_id].connections.push(c);
    } else {
      rootConnections.push(c);
    }
  }

  const sortNode = (n: FolderNode) => {
    n.children.sort((a, b) => byPositionThenName(a.folder, b.folder));
    n.connections.sort(byPositionThenName);
    n.children.forEach(sortNode);
  };
  rootFolders.sort((a, b) => byPositionThenName(a.folder, b.folder));
  rootFolders.forEach(sortNode);
  rootConnections.sort(byPositionThenName);

  return { rootFolders, rootConnections };
}

/// True when `folderId` is `ancestorId` itself or lives anywhere under it.
/// Used to forbid dropping a folder into its own subtree.
export function isSelfOrDescendant(
  folders: Folder[],
  ancestorId: string,
  folderId: string | null,
): boolean {
  const byId: Record<string, Folder> = {};
  for (const f of folders) byId[f.id] = f;
  let cur = folderId;
  const seen = new Set<string>();
  while (cur) {
    if (cur === ancestorId) return true;
    if (seen.has(cur)) return false; // corrupt cycle — bail out
    seen.add(cur);
    cur = byId[cur]?.parent_id ?? null;
  }
  return false;
}

export function folderPaths(folders: Folder[]): { folder: Folder; path: string }[] {
  const byId: Record<string, Folder> = {};
  for (const f of folders) byId[f.id] = f;

  function pathOf(f: Folder): string {
    const parts: string[] = [f.name];
    let cur: Folder | undefined = f.parent_id ? byId[f.parent_id] : undefined;
    while (cur) {
      parts.unshift(cur.name);
      cur = cur.parent_id ? byId[cur.parent_id] : undefined;
    }
    return parts.join(" / ");
  }

  return folders
    .map((f) => ({ folder: f, path: pathOf(f) }))
    .sort((a, b) => a.path.localeCompare(b.path));
}
