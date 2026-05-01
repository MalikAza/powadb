import type { Folder, SavedConnection } from "../types";

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
    n.children.sort((a, b) => a.folder.name.localeCompare(b.folder.name));
    n.connections.sort((a, b) => a.name.localeCompare(b.name));
    n.children.forEach(sortNode);
  };
  rootFolders.sort((a, b) => a.folder.name.localeCompare(b.folder.name));
  rootFolders.forEach(sortNode);
  rootConnections.sort((a, b) => a.name.localeCompare(b.name));

  return { rootFolders, rootConnections };
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
