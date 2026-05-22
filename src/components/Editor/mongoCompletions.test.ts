import type { CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { describe, expect, it } from "vitest";
import type { SchemaMeta } from "../../ipc";
import { buildMongoCompletionSource, DSL_TOP_LEVEL } from "./mongoCompletions";

// CodeMirror's CompletionContext is a heavyweight object backed by an
// EditorState. The completion source only touches three things on it —
// `pos`, `state.sliceDoc(0, pos)`, and `state.doc.toString()` — so we
// stub a lookalike rather than spin up a real EditorState per test.
function mkCtx(text: string, pos: number = text.length): CompletionContext {
  return {
    pos,
    state: {
      sliceDoc: (from: number, to: number) => text.slice(from, to),
      doc: { toString: () => text },
    },
  } as unknown as CompletionContext;
}

const SCHEMAS: SchemaMeta[] = [
  {
    name: "shop",
    tables: [
      {
        name: "users",
        kind: "collection",
        columns: [
          { name: "_id", data_type: "ObjectId", nullable: false },
          { name: "name", data_type: "string", nullable: false },
          { name: "age", data_type: "int", nullable: true },
        ],
      },
      {
        name: "orders",
        kind: "collection",
        columns: [
          { name: "_id", data_type: "ObjectId", nullable: false },
          { name: "total", data_type: "double", nullable: false },
        ],
      },
    ],
  },
  {
    name: "admin",
    tables: [],
  },
];

const source = buildMongoCompletionSource(SCHEMAS);
const sourceNoSchema = buildMongoCompletionSource(undefined);

function labels(r: CompletionResult | null): string[] {
  if (!r) return [];
  return r.options.map((o) => o.label);
}

describe("buildMongoCompletionSource: op_value", () => {
  it('suggests the seven canonical operations after `"op":`', () => {
    const r = source(mkCtx(`{ "op": "fi`));
    expect(labels(r)).toEqual([
      "find",
      "aggregate",
      "insert_one",
      "insert_many",
      "update_many",
      "delete_many",
      "run_command",
    ]);
  });

  it("anchors the replacement at the start of the partial token", () => {
    const text = `{ "op": "fi`;
    const r = source(mkCtx(text));
    expect(r?.from).toBe(text.length - 2); // "fi"
  });

  it("returns an empty prefix when the cursor sits right after the opening quote", () => {
    const text = `{ "op": "`;
    const r = source(mkCtx(text));
    expect(r?.from).toBe(text.length);
  });
});

describe("buildMongoCompletionSource: collection_value", () => {
  it("surfaces collection names across all schemas", () => {
    const r = source(mkCtx(`{ "collection": "us`));
    expect(labels(r)).toEqual(expect.arrayContaining(["users", "orders"]));
  });

  it("returns an empty list when no schemas are loaded", () => {
    const r = sourceNoSchema(mkCtx(`{ "collection": "us`));
    expect(labels(r)).toEqual([]);
  });
});

describe("buildMongoCompletionSource: database_value", () => {
  it("surfaces database (schema) names", () => {
    const r = source(mkCtx(`{ "database": "sh`));
    expect(labels(r)).toEqual(["shop", "admin"]);
  });

  it("returns an empty list with no schemas", () => {
    const r = sourceNoSchema(mkCtx(`{ "database": "`));
    expect(labels(r)).toEqual([]);
  });
});

describe("buildMongoCompletionSource: object keys", () => {
  it("offers top-level keys at depth 1 (inside the outer object)", () => {
    const r = source(mkCtx(`{ "`));
    const ls = labels(r);
    expect(ls).toEqual(
      expect.arrayContaining(["op", "collection", "filter", "projection", "sort", "limit"]),
    );
  });

  it("offers Mongo operators inside a nested object (depth > 1)", () => {
    const r = source(mkCtx(`{ "filter": { "`));
    const ls = labels(r);
    expect(ls).toEqual(expect.arrayContaining(["$eq", "$gt", "$in", "$and", "$regex"]));
  });

  it("works for bare keys too (no opening quote yet)", () => {
    const r = source(mkCtx(`{ fi`));
    expect(r?.from).toBe(2);
    expect(labels(r)).toEqual(expect.arrayContaining(["filter"]));
  });

  it("includes the active collection's fields alongside top-level keys", () => {
    // The document mentions `"collection": "users"`, so user field names
    // (`name`, `age`) should be appended.
    const text = `{ "collection": "users", "filter": {}, "`;
    const r = source(mkCtx(text));
    const ls = labels(r);
    expect(ls).toEqual(expect.arrayContaining(["op", "name", "age"]));
  });

  it("includes the active collection's fields among nested operators", () => {
    const text = `{ "collection": "users", "filter": { "`;
    const r = source(mkCtx(text));
    const ls = labels(r);
    expect(ls).toEqual(expect.arrayContaining(["$eq", "name", "age"]));
  });

  it("dedupes so the same field isn't suggested twice when overlapping a key set", () => {
    // Synthesize a collection whose field name collides with a top-level key.
    const colliding: SchemaMeta[] = [
      {
        name: "db",
        tables: [
          {
            name: "things",
            kind: "collection",
            columns: [{ name: "op", data_type: "string", nullable: true }],
          },
        ],
      },
    ];
    const src = buildMongoCompletionSource(colliding);
    const text = `{ "collection": "things", "`;
    const r = src(mkCtx(text));
    const ls = labels(r);
    expect(ls.filter((l) => l === "op").length).toBe(1);
  });
});

describe("buildMongoCompletionSource: generic value position", () => {
  it("surfaces fields, the ObjectId snippet, and DSL constructors", () => {
    // String value not tied to op/collection/database.
    const text = `{ "collection": "users", "comment": "`;
    const r = source(mkCtx(text));
    const ls = labels(r);
    expect(ls).toEqual(expect.arrayContaining(["name", "age", "ObjectId", "ISODate"]));
    expect(ls.some((l) => l.includes("$oid"))).toBe(true);
  });
});

describe("buildMongoCompletionSource: DSL contexts", () => {
  it("offers collections + runCommand after `db.`", () => {
    const r = source(mkCtx(`db.`));
    expect(labels(r)).toEqual(expect.arrayContaining(["users", "orders", "runCommand"]));
  });

  it("offers DSL methods after `db.<collection>.`", () => {
    const r = source(mkCtx(`db.users.`));
    expect(labels(r)).toEqual(
      expect.arrayContaining(["find", "findOne", "aggregate", "insertOne", "updateOne"]),
    );
  });

  it("offers chain methods after `).` ", () => {
    const r = source(mkCtx(`db.users.find({}).`));
    expect(labels(r)).toEqual(expect.arrayContaining(["limit", "skip", "sort", "project"]));
  });

  it("offers constructors after a value position when the user typed a capitalized ident", () => {
    // Inside an object value position, a bare ident starting with a capital
    // letter is most likely a constructor call.
    const r = source(mkCtx(`db.users.find({ _id: Obj`));
    expect(labels(r)).toEqual(expect.arrayContaining(["ObjectId", "ISODate", "Date"]));
  });
});

describe("buildMongoCompletionSource: no-match positions", () => {
  it("returns null on an empty document", () => {
    expect(source(mkCtx(``))).toBeNull();
  });

  it("returns null on plain whitespace", () => {
    expect(source(mkCtx(`   `))).toBeNull();
  });
});

describe("DSL_TOP_LEVEL export", () => {
  it("exposes the `db` namespace identifier", () => {
    // Exported only for future snippet features — assert the shape so any
    // accidental rename doesn't slip through.
    expect(DSL_TOP_LEVEL.map((o) => o.label)).toEqual(["db"]);
  });
});
