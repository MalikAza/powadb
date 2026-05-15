import { describe, expect, it } from "vitest";
import { parseJsonImport, parseSqlImport } from "./importDiagram";
import type { DiagramDoc } from "./types";

describe("parseJsonImport", () => {
  it("loads a valid doc round-trip", () => {
    const original: DiagramDoc = {
      version: 1,
      engine: "postgres",
      tables: [
        {
          id: "public.users",
          schema: "public",
          name: "users",
          originalName: "users",
          position: { x: 42, y: 7 },
          columns: [
            {
              id: "public.users.id",
              name: "id",
              originalName: "id",
              dataType: "integer",
              nullable: false,
              isPk: true,
              isFk: false,
              defaultValue: null,
            },
          ],
        },
      ],
      edges: [],
    };
    const { doc, warnings } = parseJsonImport(JSON.stringify(original));
    expect(warnings).toEqual([]);
    expect(doc.tables).toHaveLength(1);
    expect(doc.tables[0].position).toEqual({ x: 42, y: 7 });
  });

  it("rejects invalid JSON with a clear error", () => {
    expect(() => parseJsonImport("not json")).toThrow(/Invalid JSON/);
  });

  it("rejects docs that fail Zod validation", () => {
    expect(() =>
      parseJsonImport(JSON.stringify({ version: 1, engine: "oracle", tables: [], edges: [] })),
    ).toThrow(/validation failed/);
  });
});

describe("parseSqlImport (Postgres)", () => {
  it("parses CREATE TABLE with PK + NOT NULL + DEFAULT", async () => {
    const sql = `
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        name VARCHAR(255) NOT NULL DEFAULT 'anon',
        balance NUMERIC(10,2)
      );
    `;
    const { doc, warnings } = await parseSqlImport(sql, "postgres");
    expect(warnings).toEqual([]);
    expect(doc.tables).toHaveLength(1);
    const t = doc.tables[0];
    expect(t.name).toBe("users");
    const id = t.columns.find((c) => c.name === "id");
    const name = t.columns.find((c) => c.name === "name");
    const balance = t.columns.find((c) => c.name === "balance");
    expect(id?.isPk).toBe(true);
    expect(id?.nullable).toBe(false);
    expect(name?.dataType).toBe("varchar(255)");
    expect(name?.nullable).toBe(false);
    expect(name?.defaultValue).toBe("'anon'");
    expect(balance?.dataType).toBe("numeric(10,2)");
  });

  it("parses inline FK references", async () => {
    const sql = `
      CREATE TABLE authors (id INTEGER PRIMARY KEY);
      CREATE TABLE books (
        id INTEGER PRIMARY KEY,
        author_id INTEGER REFERENCES authors(id) ON DELETE CASCADE
      );
    `;
    const { doc, warnings } = await parseSqlImport(sql, "postgres");
    expect(warnings).toEqual([]);
    expect(doc.edges).toHaveLength(1);
    const fk = doc.edges[0];
    expect(fk.source).toBe("public.books");
    expect(fk.target).toBe("public.authors");
    expect(fk.sourceColumns).toEqual(["author_id"]);
    expect(fk.targetColumns).toEqual(["id"]);
    expect(fk.onDelete).toBe("CASCADE");
    const authorCol = doc.tables
      .find((t) => t.name === "books")
      ?.columns.find((c) => c.name === "author_id");
    expect(authorCol?.isFk).toBe(true);
  });

  it("parses ALTER TABLE ADD CONSTRAINT FOREIGN KEY", async () => {
    const sql = `
      CREATE TABLE authors (id INTEGER PRIMARY KEY);
      CREATE TABLE books (id INTEGER PRIMARY KEY, author_id INTEGER);
      ALTER TABLE books ADD CONSTRAINT books_author_fk
        FOREIGN KEY (author_id) REFERENCES authors(id);
    `;
    const { doc, warnings } = await parseSqlImport(sql, "postgres");
    expect(warnings).toEqual([]);
    expect(doc.edges).toHaveLength(1);
    expect(doc.edges[0].name).toBe("books_author_fk");
  });

  it("emits a warning for unparseable statements but keeps importing the rest", async () => {
    const sql = `
      THIS IS NOT VALID SQL;
      CREATE TABLE good (id INTEGER PRIMARY KEY);
    `;
    const { doc, warnings } = await parseSqlImport(sql, "postgres");
    expect(doc.tables).toHaveLength(1);
    expect(doc.tables[0].name).toBe("good");
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.some((w) => /unparseable/i.test(w))).toBe(true);
  });

  it("emits a warning for FKs targeting tables not in the dump", async () => {
    const sql = `
      CREATE TABLE books (id INTEGER PRIMARY KEY, author_id INTEGER REFERENCES authors(id));
    `;
    const { doc, warnings } = await parseSqlImport(sql, "postgres");
    expect(doc.edges).toHaveLength(0);
    expect(warnings.some((w) => /unknown table/i.test(w))).toBe(true);
  });
});
