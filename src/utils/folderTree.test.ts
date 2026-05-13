import { describe, expect, it } from "vitest";
import type { Folder, SavedConnection } from "../types";
import { buildTree, folderPaths } from "./folderTree";

const conn = (over: Partial<SavedConnection>): SavedConnection => ({
  id: over.id ?? "c",
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
});

const folder = (id: string, name: string, parent_id: string | null = null): Folder => ({
  id,
  name,
  parent_id,
});

describe("buildTree", () => {
  it("places orphan items at the root", () => {
    const tree = buildTree([], [conn({ id: "c1", name: "alpha" })]);
    expect(tree.rootFolders).toEqual([]);
    expect(tree.rootConnections).toHaveLength(1);
    expect(tree.rootConnections[0]?.id).toBe("c1");
  });

  it("nests subfolders under their parents", () => {
    const tree = buildTree([folder("root", "Root"), folder("child", "Child", "root")], []);
    expect(tree.rootFolders).toHaveLength(1);
    expect(tree.rootFolders[0]?.folder.id).toBe("root");
    expect(tree.rootFolders[0]?.children).toHaveLength(1);
    expect(tree.rootFolders[0]?.children[0]?.folder.id).toBe("child");
  });

  it("assigns connections to their folder", () => {
    const tree = buildTree(
      [folder("f1", "Work")],
      [conn({ id: "c1", name: "prod", folder_id: "f1" })],
    );
    expect(tree.rootFolders[0]?.connections).toHaveLength(1);
    expect(tree.rootFolders[0]?.connections[0]?.id).toBe("c1");
    expect(tree.rootConnections).toHaveLength(0);
  });

  it("promotes connections whose folder no longer exists to the root", () => {
    const tree = buildTree([], [conn({ id: "orphan", folder_id: "missing" })]);
    expect(tree.rootConnections).toHaveLength(1);
  });

  it("sorts folders and connections alphabetically at each level", () => {
    const tree = buildTree(
      [folder("a", "Zeta"), folder("b", "Alpha")],
      [conn({ id: "c1", name: "delta" }), conn({ id: "c2", name: "bravo" })],
    );
    expect(tree.rootFolders.map((n) => n.folder.name)).toEqual(["Alpha", "Zeta"]);
    expect(tree.rootConnections.map((c) => c.name)).toEqual(["bravo", "delta"]);
  });
});

describe("folderPaths", () => {
  it("renders the breadcrumb of each folder", () => {
    const folders = [
      folder("root", "Root"),
      folder("mid", "Mid", "root"),
      folder("leaf", "Leaf", "mid"),
    ];
    const paths = folderPaths(folders);
    expect(paths.find((p) => p.folder.id === "leaf")?.path).toBe("Root / Mid / Leaf");
    expect(paths.find((p) => p.folder.id === "root")?.path).toBe("Root");
  });

  it("sorts paths alphabetically", () => {
    const paths = folderPaths([folder("a", "Zeta"), folder("b", "Alpha")]);
    expect(paths.map((p) => p.path)).toEqual(["Alpha", "Zeta"]);
  });
});
