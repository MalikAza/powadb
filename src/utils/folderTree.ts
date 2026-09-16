import type { Folder } from "../types";

/// Anything a sidebar folder tree can hold: a connection, a snippet, … The
/// tree only ever reads these four fields, so both sidebars share one builder.
export type TreeItem = {
  id: string;
  name: string;
  folder_id: string | null;
  position: number | null;
};

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

export type FolderNode<I extends TreeItem> = {
  folder: Folder;
  children: FolderNode<I>[];
  items: I[];
};

export type Tree<I extends TreeItem> = {
  rootFolders: FolderNode<I>[];
  rootItems: I[];
};

export function buildTree<I extends TreeItem>(folders: Folder[], items: I[]): Tree<I> {
  const nodeById: Record<string, FolderNode<I>> = {};
  for (const f of folders) {
    nodeById[f.id] = { folder: f, children: [], items: [] };
  }

  const rootFolders: FolderNode<I>[] = [];
  for (const f of folders) {
    const node = nodeById[f.id];
    if (f.parent_id && nodeById[f.parent_id]) {
      nodeById[f.parent_id].children.push(node);
    } else {
      rootFolders.push(node);
    }
  }

  const rootItems: I[] = [];
  for (const c of items) {
    if (c.folder_id && nodeById[c.folder_id]) {
      nodeById[c.folder_id].items.push(c);
    } else {
      rootItems.push(c);
    }
  }

  const sortNode = (n: FolderNode<I>) => {
    n.children.sort((a, b) => byPositionThenName(a.folder, b.folder));
    n.items.sort(byPositionThenName);
    n.children.forEach(sortNode);
  };
  rootFolders.sort((a, b) => byPositionThenName(a.folder, b.folder));
  rootFolders.forEach(sortNode);
  rootItems.sort(byPositionThenName);

  return { rootFolders, rootItems };
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
