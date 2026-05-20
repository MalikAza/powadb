import { describe, expect, it } from "vitest";
import {
  addEdge,
  addTable,
  emptyDoc,
  ensureUniqueTableName,
  parseHandleId,
  removeEdge,
  removeTable,
  updateTablePosition,
} from "./docHelpers";
import type { DiagramDoc } from "./types";

const colInit = (name: string, isPk = false) => ({
  name,
  dataType: "integer",
  nullable: !isPk,
  isPk,
  defaultValue: null,
});

describe("emptyDoc", () => {
  it("returns a v1 doc with the given engine and no tables/edges", () => {
    expect(emptyDoc("postgres")).toEqual({
      version: 1,
      engine: "postgres",
      tables: [],
      edges: [],
    });
  });

  it("defaults engine independently per call (no shared state)", () => {
    const a = emptyDoc("postgres");
    const b = emptyDoc("mysql");
    expect(a.engine).toBe("postgres");
    expect(b.engine).toBe("mysql");
  });
});

describe("ensureUniqueTableName", () => {
  const doc = emptyDoc("postgres");

  it("returns the base name if it isn't taken", () => {
    expect(ensureUniqueTableName(doc, "users")).toBe("users");
  });

  it("suffixes `_2`, `_3`, ... when collisions exist", () => {
    const { doc: d1 } = addTable(doc, { name: "users", columns: [colInit("id", true)] });
    expect(ensureUniqueTableName(d1, "users")).toBe("users_2");
    const { doc: d2 } = addTable(d1, { name: "users_2", columns: [colInit("id", true)] });
    expect(ensureUniqueTableName(d2, "users")).toBe("users_3");
  });
});

describe("addTable", () => {
  it("uses 'public' schema for Postgres", () => {
    const { doc, tableId } = addTable(emptyDoc("postgres"), {
      name: "users",
      columns: [colInit("id", true)],
    });
    expect(tableId).toBe("public.users");
    expect(doc.tables[0].schema).toBe("public");
  });

  it("uses 'main' schema for SQLite", () => {
    const { doc, tableId } = addTable(emptyDoc("sqlite"), {
      name: "users",
      columns: [colInit("id", true)],
    });
    expect(tableId).toBe("main.users");
    expect(doc.tables[0].schema).toBe("main");
  });

  it("uses empty schema for MySQL", () => {
    const { doc, tableId } = addTable(emptyDoc("mysql"), {
      name: "users",
      columns: [colInit("id", true)],
    });
    expect(tableId).toBe(".users");
    expect(doc.tables[0].schema).toBe("");
  });

  it("renames duplicates and gives the new id reflecting the deduped name", () => {
    const { doc: d1 } = addTable(emptyDoc("postgres"), {
      name: "users",
      columns: [colInit("id", true)],
    });
    const { doc: d2, tableId } = addTable(d1, {
      name: "users",
      columns: [colInit("id", true)],
    });
    expect(tableId).toBe("public.users_2");
    expect(d2.tables).toHaveLength(2);
    expect(d2.tables.map((t) => t.name).sort()).toEqual(["users", "users_2"]);
  });

  it("uses the provided position when given", () => {
    const { doc } = addTable(
      emptyDoc("postgres"),
      { name: "users", columns: [colInit("id", true)] },
      { x: 11, y: 22 },
    );
    expect(doc.tables[0].position).toEqual({ x: 11, y: 22 });
  });

  it("falls back to {60,60} for the very first table when no position given", () => {
    const { doc } = addTable(emptyDoc("postgres"), {
      name: "users",
      columns: [colInit("id", true)],
    });
    expect(doc.tables[0].position).toEqual({ x: 60, y: 60 });
  });

  it("offsets subsequent tables to the right of the rightmost existing one", () => {
    let { doc } = addTable(
      emptyDoc("postgres"),
      { name: "a", columns: [colInit("id", true)] },
      { x: 100, y: 50 },
    );
    ({ doc } = addTable(doc, { name: "b", columns: [colInit("id", true)] }));
    // second table → maxX + 320, maxY
    expect(doc.tables[1].position).toEqual({ x: 420, y: 50 });
  });

  it("seeds isFk=false on every column and preserves defaultValue", () => {
    const { doc } = addTable(emptyDoc("postgres"), {
      name: "t",
      columns: [
        { name: "id", dataType: "integer", nullable: false, isPk: true, defaultValue: null },
        {
          name: "name",
          dataType: "text",
          nullable: false,
          isPk: false,
          defaultValue: "'anon'",
        },
      ],
    });
    expect(doc.tables[0].columns.every((c) => c.isFk === false)).toBe(true);
    expect(doc.tables[0].columns[1].defaultValue).toBe("'anon'");
    // missing defaultValue should normalize to null
    expect(doc.tables[0].columns[0].defaultValue).toBeNull();
  });
});

describe("removeTable", () => {
  it("removes the table and any edges that touch it", () => {
    let { doc, tableId: booksId } = addTable(emptyDoc("postgres"), {
      name: "books",
      columns: [colInit("id", true), colInit("author_id")],
    });
    const { doc: d2, tableId: authorsId } = addTable(doc, {
      name: "authors",
      columns: [colInit("id", true)],
    });
    doc = addEdge(d2, {
      source: booksId,
      target: authorsId,
      sourceColumns: ["author_id"],
      targetColumns: ["id"],
    });
    const removed = removeTable(doc, authorsId);
    expect(removed.tables.find((t) => t.id === authorsId)).toBeUndefined();
    expect(removed.edges).toHaveLength(0);
  });

  it("re-syncs isFk on the surviving table when its edge is dropped", () => {
    let { doc, tableId: booksId } = addTable(emptyDoc("postgres"), {
      name: "books",
      columns: [colInit("id", true), colInit("author_id")],
    });
    const { doc: d2, tableId: authorsId } = addTable(doc, {
      name: "authors",
      columns: [colInit("id", true)],
    });
    doc = addEdge(d2, {
      source: booksId,
      target: authorsId,
      sourceColumns: ["author_id"],
      targetColumns: ["id"],
    });
    expect(
      doc.tables.find((t) => t.id === booksId)!.columns.find((c) => c.name === "author_id")!.isFk,
    ).toBe(true);
    const removed = removeTable(doc, authorsId);
    const books = removed.tables.find((t) => t.id === booksId)!;
    expect(books.columns.find((c) => c.name === "author_id")!.isFk).toBe(false);
  });

  it("is a no-op when the table id doesn't exist", () => {
    const { doc } = addTable(emptyDoc("postgres"), {
      name: "users",
      columns: [colInit("id", true)],
    });
    const out = removeTable(doc, "public.ghost");
    expect(out.tables).toHaveLength(1);
  });
});

describe("updateTablePosition", () => {
  it("moves the matched table and leaves others untouched", () => {
    let { doc, tableId: aId } = addTable(emptyDoc("postgres"), {
      name: "a",
      columns: [colInit("id", true)],
    });
    const { doc: d2, tableId: bId } = addTable(doc, {
      name: "b",
      columns: [colInit("id", true)],
    });
    doc = updateTablePosition(d2, aId, { x: 999, y: 999 });
    expect(doc.tables.find((t) => t.id === aId)!.position).toEqual({ x: 999, y: 999 });
    expect(doc.tables.find((t) => t.id === bId)!.position).not.toEqual({ x: 999, y: 999 });
  });

  it("returns a new doc reference (immutable update)", () => {
    const { doc, tableId } = addTable(emptyDoc("postgres"), {
      name: "a",
      columns: [colInit("id", true)],
    });
    const next = updateTablePosition(doc, tableId, { x: 1, y: 2 });
    expect(next).not.toBe(doc);
    expect(next.tables).not.toBe(doc.tables);
  });
});

describe("addEdge", () => {
  function withTwoTables(): { doc: DiagramDoc; booksId: string; authorsId: string } {
    const a = addTable(emptyDoc("postgres"), {
      name: "books",
      columns: [colInit("id", true), colInit("author_id")],
    });
    const b = addTable(a.doc, { name: "authors", columns: [colInit("id", true)] });
    return { doc: b.doc, booksId: a.tableId, authorsId: b.tableId };
  }

  it("inserts an edge and updates isFk on the source column", () => {
    const { doc, booksId, authorsId } = withTwoTables();
    const out = addEdge(doc, {
      source: booksId,
      target: authorsId,
      sourceColumns: ["author_id"],
      targetColumns: ["id"],
    });
    expect(out.edges).toHaveLength(1);
    const books = out.tables.find((t) => t.id === booksId)!;
    expect(books.columns.find((c) => c.name === "author_id")!.isFk).toBe(true);
  });

  it("ignores exact duplicates (same source+target+columns)", () => {
    const { doc, booksId, authorsId } = withTwoTables();
    const one = addEdge(doc, {
      source: booksId,
      target: authorsId,
      sourceColumns: ["author_id"],
      targetColumns: ["id"],
    });
    const two = addEdge(one, {
      source: booksId,
      target: authorsId,
      sourceColumns: ["author_id"],
      targetColumns: ["id"],
    });
    expect(two.edges).toHaveLength(1);
    expect(two).toBe(one); // same reference: short-circuit
  });

  it("adds a second edge if column lists differ", () => {
    const { doc, booksId, authorsId } = withTwoTables();
    const one = addEdge(doc, {
      source: booksId,
      target: authorsId,
      sourceColumns: ["author_id"],
      targetColumns: ["id"],
    });
    const two = addEdge(one, {
      source: booksId,
      target: authorsId,
      sourceColumns: ["id"],
      targetColumns: ["id"],
    });
    expect(two.edges).toHaveLength(2);
  });

  it("uses the provided name when supplied; null otherwise", () => {
    const { doc, booksId, authorsId } = withTwoTables();
    const named = addEdge(doc, {
      source: booksId,
      target: authorsId,
      sourceColumns: ["author_id"],
      targetColumns: ["id"],
      name: "books_author_fk",
    });
    expect(named.edges[0].name).toBe("books_author_fk");

    const unnamed = addEdge(doc, {
      source: booksId,
      target: authorsId,
      sourceColumns: ["author_id"],
      targetColumns: ["id"],
    });
    expect(unnamed.edges[0].name).toBeNull();
  });
});

describe("removeEdge", () => {
  it("drops the edge by id and clears isFk on the freed source column", () => {
    let { doc, tableId: booksId } = addTable(emptyDoc("postgres"), {
      name: "books",
      columns: [colInit("id", true), colInit("author_id")],
    });
    const { doc: d2, tableId: authorsId } = addTable(doc, {
      name: "authors",
      columns: [colInit("id", true)],
    });
    doc = addEdge(d2, {
      source: booksId,
      target: authorsId,
      sourceColumns: ["author_id"],
      targetColumns: ["id"],
    });
    const edgeId = doc.edges[0].id;
    const out = removeEdge(doc, edgeId);
    expect(out.edges).toHaveLength(0);
    const books = out.tables.find((t) => t.id === booksId)!;
    expect(books.columns.find((c) => c.name === "author_id")!.isFk).toBe(false);
  });

  it("is a no-op on an unknown edge id", () => {
    const { doc } = addTable(emptyDoc("postgres"), {
      name: "users",
      columns: [colInit("id", true)],
    });
    const out = removeEdge(doc, "fk-ghost");
    expect(out.edges).toEqual([]);
    expect(out.tables).toHaveLength(1);
  });
});

describe("parseHandleId", () => {
  it("splits `schema.table.column::source` into tableId and column", () => {
    expect(parseHandleId("public.users.email::source")).toEqual({
      tableId: "public.users",
      columnName: "email",
    });
  });

  it("splits `schema.table.column::target` the same way", () => {
    expect(parseHandleId("public.users.email::target")).toEqual({
      tableId: "public.users",
      columnName: "email",
    });
  });

  it("treats the last dot as the column separator (handles compound table ids)", () => {
    expect(parseHandleId("public.users.audit.created_at::source")).toEqual({
      tableId: "public.users.audit",
      columnName: "created_at",
    });
  });

  it("returns null for nullish or empty input", () => {
    expect(parseHandleId(null)).toBeNull();
    expect(parseHandleId(undefined)).toBeNull();
    expect(parseHandleId("")).toBeNull();
  });

  it("returns null when there is no dot to split on", () => {
    expect(parseHandleId("nodothere::source")).toBeNull();
  });

  it("accepts handles without the `::role` suffix", () => {
    expect(parseHandleId("public.users.email")).toEqual({
      tableId: "public.users",
      columnName: "email",
    });
  });
});
