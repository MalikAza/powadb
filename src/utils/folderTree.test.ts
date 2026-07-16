import { describe, expect, it } from "vitest";
import type { Folder, SavedConnection } from "../types";
import { buildTree, folderPaths, isSelfOrDescendant } from "./folderTree";

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
  position: over.position ?? null,
  wg: null,
  ssh: null,
});

const folder = (
  id: string,
  name: string,
  parent_id: string | null = null,
  position: number | null = null,
): Folder => ({
  id,
  name,
  parent_id,
  position,
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

  it("sorts positioned items first, then null positions alphabetically", () => {
    const tree = buildTree(
      [folder("fz", "Zeta", null, 0), folder("fa", "Alpha"), folder("fm", "Mu")],
      [
        conn({ id: "c1", name: "delta", position: 1 }),
        conn({ id: "c2", name: "bravo" }),
        conn({ id: "c3", name: "zulu", position: 0 }),
      ],
    );
    // Zeta was manually pinned to the top; Alpha/Mu keep the name fallback.
    expect(tree.rootFolders.map((n) => n.folder.name)).toEqual(["Zeta", "Alpha", "Mu"]);
    expect(tree.rootConnections.map((c) => c.name)).toEqual(["zulu", "delta", "bravo"]);
  });

  it("sorts by position inside folders too", () => {
    const tree = buildTree(
      [folder("f1", "Work")],
      [
        conn({ id: "c1", name: "alpha", folder_id: "f1", position: 1 }),
        conn({ id: "c2", name: "beta", folder_id: "f1", position: 0 }),
      ],
    );
    expect(tree.rootFolders[0]?.connections.map((c) => c.id)).toEqual(["c2", "c1"]);
  });
});

describe("isSelfOrDescendant", () => {
  const folders = [
    folder("root", "Root"),
    folder("mid", "Mid", "root"),
    folder("leaf", "Leaf", "mid"),
  ];

  it("matches the folder itself", () => {
    expect(isSelfOrDescendant(folders, "mid", "mid")).toBe(true);
  });

  it("matches deep descendants", () => {
    expect(isSelfOrDescendant(folders, "root", "leaf")).toBe(true);
  });

  it("rejects ancestors and siblings", () => {
    expect(isSelfOrDescendant(folders, "leaf", "root")).toBe(false);
    expect(isSelfOrDescendant(folders, "mid", null)).toBe(false);
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
