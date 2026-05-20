import { describe, expect, it } from "vitest";
import type { DiagColumn, DiagFk, DiagramIntrospection } from "@/ipc";
import { type DiagramDoc, introspectionToDoc, renderDataType, syncFkFlags, tableId } from "./types";

const makeCol = (overrides: Partial<DiagColumn> = {}): DiagColumn => ({
  name: "id",
  data_type: "integer",
  nullable: false,
  is_pk: true,
  default: null,
  ordinal: 0,
  char_max_len: null,
  numeric_precision: null,
  numeric_scale: null,
  ...overrides,
});

describe("tableId", () => {
  it("joins schema and name with a dot", () => {
    expect(tableId("public", "users")).toBe("public.users");
  });

  it("preserves the leading dot when schema is empty (e.g. MySQL)", () => {
    expect(tableId("", "users")).toBe(".users");
  });
});

describe("renderDataType", () => {
  it("renders varchar with explicit length", () => {
    expect(renderDataType(makeCol({ data_type: "character varying", char_max_len: 64 }))).toBe(
      "varchar(64)",
    );
  });

  it("falls back to bare varchar when length is missing", () => {
    expect(renderDataType(makeCol({ data_type: "character varying", char_max_len: null }))).toBe(
      "varchar",
    );
  });

  it("renders char with explicit length", () => {
    expect(renderDataType(makeCol({ data_type: "character", char_max_len: 10 }))).toBe("char(10)");
  });

  it("falls back to bare char when length is missing", () => {
    expect(renderDataType(makeCol({ data_type: "character", char_max_len: null }))).toBe("char");
  });

  it("renders numeric with precision and scale", () => {
    expect(
      renderDataType(makeCol({ data_type: "numeric", numeric_precision: 10, numeric_scale: 2 })),
    ).toBe("numeric(10,2)");
  });

  it("renders decimal with precision only when scale is missing", () => {
    expect(
      renderDataType(makeCol({ data_type: "decimal", numeric_precision: 12, numeric_scale: null })),
    ).toBe("decimal(12)");
  });

  it("falls back to bare numeric when neither precision nor scale present", () => {
    expect(renderDataType(makeCol({ data_type: "numeric" }))).toBe("numeric");
  });

  it("passes other types through unchanged", () => {
    expect(renderDataType(makeCol({ data_type: "integer" }))).toBe("integer");
    expect(renderDataType(makeCol({ data_type: "jsonb" }))).toBe("jsonb");
  });
});

describe("syncFkFlags", () => {
  const baseDoc: DiagramDoc = {
    version: 1,
    engine: "postgres",
    tables: [
      {
        id: "public.books",
        schema: "public",
        name: "books",
        position: { x: 0, y: 0 },
        columns: [
          {
            id: "public.books.id",
            name: "id",
            dataType: "integer",
            nullable: false,
            isPk: true,
            isFk: false,
            defaultValue: null,
          },
          {
            id: "public.books.author_id",
            name: "author_id",
            dataType: "integer",
            nullable: true,
            isPk: false,
            isFk: false,
            defaultValue: null,
          },
        ],
      },
      {
        id: "public.authors",
        schema: "public",
        name: "authors",
        position: { x: 0, y: 0 },
        columns: [
          {
            id: "public.authors.id",
            name: "id",
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

  it("sets isFk=true on every source column of an edge", () => {
    const synced = syncFkFlags({
      ...baseDoc,
      edges: [
        {
          id: "fk-1",
          name: null,
          source: "public.books",
          target: "public.authors",
          sourceColumns: ["author_id"],
          targetColumns: ["id"],
          onUpdate: null,
          onDelete: null,
        },
      ],
    });
    const books = synced.tables.find((t) => t.name === "books")!;
    expect(books.columns.find((c) => c.name === "author_id")!.isFk).toBe(true);
    expect(books.columns.find((c) => c.name === "id")!.isFk).toBe(false);
  });

  it("clears isFk when no edge references the column", () => {
    const dirty: DiagramDoc = {
      ...baseDoc,
      tables: baseDoc.tables.map((t) =>
        t.name === "books" ? { ...t, columns: t.columns.map((c) => ({ ...c, isFk: true })) } : t,
      ),
      edges: [],
    };
    const synced = syncFkFlags(dirty);
    const books = synced.tables.find((t) => t.name === "books")!;
    for (const c of books.columns) expect(c.isFk).toBe(false);
  });

  it("does not flag target columns — only the source side carries the FK", () => {
    const synced = syncFkFlags({
      ...baseDoc,
      edges: [
        {
          id: "fk-1",
          name: null,
          source: "public.books",
          target: "public.authors",
          sourceColumns: ["author_id"],
          targetColumns: ["id"],
          onUpdate: null,
          onDelete: null,
        },
      ],
    });
    const authors = synced.tables.find((t) => t.name === "authors")!;
    expect(authors.columns.find((c) => c.name === "id")!.isFk).toBe(false);
  });
});

describe("introspectionToDoc", () => {
  const intro: DiagramIntrospection = {
    tables: [
      {
        schema: "public",
        name: "authors",
        indexes: [],
        columns: [
          {
            name: "id",
            data_type: "integer",
            nullable: false,
            is_pk: true,
            default: null,
            ordinal: 0,
            char_max_len: null,
            numeric_precision: null,
            numeric_scale: null,
          },
        ],
      },
      {
        schema: "public",
        name: "books",
        indexes: [],
        columns: [
          {
            name: "id",
            data_type: "integer",
            nullable: false,
            is_pk: true,
            default: null,
            ordinal: 0,
            char_max_len: null,
            numeric_precision: null,
            numeric_scale: null,
          },
          {
            name: "author_id",
            data_type: "integer",
            nullable: true,
            is_pk: false,
            default: null,
            ordinal: 1,
            char_max_len: null,
            numeric_precision: null,
            numeric_scale: null,
          },
        ],
      },
    ],
    foreign_keys: [
      {
        id: "fk-real",
        name: "books_author_fk",
        from_schema: "public",
        from_table: "books",
        from_columns: ["author_id"],
        to_schema: "public",
        to_table: "authors",
        to_columns: ["id"],
        on_update: null,
        on_delete: "CASCADE",
      },
      {
        // dangling FK whose source table isn't in the intro list
        id: "fk-dangling",
        name: null,
        from_schema: "public",
        from_table: "ghost",
        from_columns: ["author_id"],
        to_schema: "public",
        to_table: "authors",
        to_columns: ["id"],
        on_update: null,
        on_delete: null,
      },
    ] satisfies DiagFk[],
    sequences: [],
  };

  it("maps tables and columns and stamps originalName for diffing", () => {
    const doc = introspectionToDoc(intro, "postgres");
    expect(doc.engine).toBe("postgres");
    expect(doc.tables).toHaveLength(2);
    const books = doc.tables.find((t) => t.name === "books")!;
    expect(books.originalName).toBe("books");
    const authorId = books.columns.find((c) => c.name === "author_id")!;
    expect(authorId.originalName).toBe("author_id");
    expect(authorId.isFk).toBe(true);
    expect(books.columns.find((c) => c.name === "id")!.isFk).toBe(false);
  });

  it("emits an edge per known FK and skips dangling ones", () => {
    const doc = introspectionToDoc(intro, "postgres");
    expect(doc.edges).toHaveLength(1);
    expect(doc.edges[0]).toMatchObject({
      id: "fk-real",
      name: "books_author_fk",
      source: "public.books",
      target: "public.authors",
      sourceColumns: ["author_id"],
      targetColumns: ["id"],
      onDelete: "CASCADE",
    });
  });

  it("starts every table at the origin (layout fills in positions later)", () => {
    const doc = introspectionToDoc(intro, "postgres");
    for (const t of doc.tables) expect(t.position).toEqual({ x: 0, y: 0 });
  });
});
