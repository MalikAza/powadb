import { describe, expect, it } from "vitest";
import { type ParseResult, parseMongoDsl } from "./mongoDsl";

// `Record<string, unknown>` keeps the tests succinct — callers index fields
// directly without re-asserting per-variant types (each `expect(...)` does
// its own shape check via toEqual).
function parseOk(src: string): Record<string, unknown> {
  const r = parseMongoDsl(src);
  if (!r.ok) throw new Error(`expected ok, got error: ${r.error}`);
  return r.op as unknown as Record<string, unknown>;
}

function parseErr(src: string): string {
  const r = parseMongoDsl(src);
  if (r.ok) throw new Error(`expected error, got ok: ${JSON.stringify(r.op)}`);
  return r.error;
}

describe("mongoDsl: find", () => {
  it("parses a bare find()", () => {
    const op = parseOk(`db.users.find()`);
    expect(op).toEqual({ op: "find", collection: "users", filter: {} });
  });

  it("parses find with filter", () => {
    const op = parseOk(`db.users.find({ name: "alice" })`);
    expect(op).toEqual({
      op: "find",
      collection: "users",
      filter: { name: "alice" },
    });
  });

  it("parses chained limit/skip/sort/project", () => {
    const op = parseOk(
      `db.users.find({}).limit(10).skip(5).sort({ name: 1 }).project({ _id: 0, name: 1 })`,
    );
    expect(op).toEqual({
      op: "find",
      collection: "users",
      filter: {},
      limit: 10,
      skip: 5,
      sort: { name: 1 },
      projection: { _id: 0, name: 1 },
    });
  });

  it("parses negative sort direction", () => {
    const op = parseOk(`db.users.find({}).sort({ createdAt: -1 })`);
    expect(op).toEqual({
      op: "find",
      collection: "users",
      filter: {},
      sort: { createdAt: -1 },
    });
  });

  it("rejects chain methods on non-find", () => {
    const err = parseErr(`db.users.insertOne({}).limit(1)`);
    expect(err).toMatch(/can only be chained off find/);
  });
});

describe("mongoDsl: findOne", () => {
  it("parses findOne with ObjectId", () => {
    const op = parseOk(`db.users.findOne({ _id: ObjectId("507f1f77bcf86cd799439011") })`);
    expect(op).toEqual({
      op: "find_one",
      collection: "users",
      filter: { _id: { $oid: "507f1f77bcf86cd799439011" } },
    });
  });
});

describe("mongoDsl: aggregate", () => {
  it("parses aggregate with pipeline", () => {
    const op = parseOk(
      `db.orders.aggregate([{ $match: { status: "shipped" } }, { $group: { _id: "$customer", total: { $sum: 1 } } }])`,
    );
    expect(op).toEqual({
      op: "aggregate",
      collection: "orders",
      pipeline: [
        { $match: { status: "shipped" } },
        { $group: { _id: "$customer", total: { $sum: 1 } } },
      ],
    });
  });

  it("rejects non-array pipeline", () => {
    const err = parseErr(`db.orders.aggregate({ $match: {} })`);
    expect(err).toMatch(/array of stage objects/);
  });
});

describe("mongoDsl: writes", () => {
  it("parses insertOne", () => {
    const op = parseOk(`db.users.insertOne({ name: "alice", age: 30 })`);
    expect(op).toEqual({
      op: "insert_one",
      collection: "users",
      document: { name: "alice", age: 30 },
    });
  });

  it("parses insertMany", () => {
    const op = parseOk(`db.users.insertMany([{ name: "a" }, { name: "b" }])`);
    expect(op).toEqual({
      op: "insert_many",
      collection: "users",
      documents: [{ name: "a" }, { name: "b" }],
    });
  });

  it("parses updateOne vs updateMany distinctly", () => {
    const one = parseOk(`db.users.updateOne({ _id: 1 }, { $set: { age: 30 } })`);
    expect(one.op).toBe("update_one");
    const many = parseOk(`db.users.updateMany({ active: true }, { $set: { age: 30 } })`);
    expect(many.op).toBe("update_many");
  });

  it("parses deleteOne vs deleteMany distinctly", () => {
    expect(parseOk(`db.users.deleteOne({ _id: 1 })`).op).toBe("delete_one");
    expect(parseOk(`db.users.deleteMany({ archived: true })`).op).toBe("delete_many");
  });

  it("rejects wrong arity", () => {
    expect(parseErr(`db.users.updateOne({})`)).toMatch(/expects 2/);
    expect(parseErr(`db.users.deleteOne()`)).toMatch(/expects 1/);
  });
});

describe("mongoDsl: use <db> prefix", () => {
  it("attaches database to the op", () => {
    const op = parseOk(`use commune; db.users.findOne({ _id: 1 })`);
    expect(op).toEqual({
      op: "find_one",
      collection: "users",
      filter: { _id: 1 },
      database: "commune",
    });
  });

  it("accepts a quoted database name", () => {
    const op = parseOk(`use "my-db"; db.x.find({})`);
    expect(op.database).toBe("my-db");
  });

  it("works without a trailing semicolon", () => {
    const op = parseOk(`use foo db.x.find({})`);
    expect(op.database).toBe("foo");
  });

  it("does not attach a database when use is absent", () => {
    const op = parseOk(`db.x.find({})`);
    expect(op).not.toHaveProperty("database");
  });

  it("does not attach a database to runCommand (no field on that variant)", () => {
    const op = parseOk(`use admin; db.runCommand({ ping: 1 })`);
    expect(op).not.toHaveProperty("database");
  });

  it("rejects use without an argument", () => {
    expect(parseErr(`use; db.x.find({})`)).toMatch(/expected database name after 'use'/);
  });
});

describe("mongoDsl: runCommand", () => {
  it("parses runCommand", () => {
    const op = parseOk(`db.runCommand({ ping: 1 })`);
    expect(op).toEqual({ op: "run_command", value: { ping: 1 } });
  });
});

describe("mongoDsl: ctor lifting", () => {
  it("lifts ObjectId to extJSON", () => {
    const op = parseOk(`db.x.find({ _id: ObjectId("507f1f77bcf86cd799439011") })`);
    expect((op as { filter: unknown }).filter).toEqual({
      _id: { $oid: "507f1f77bcf86cd799439011" },
    });
  });

  it("rejects ObjectId with wrong arg", () => {
    expect(parseErr(`db.x.find({ _id: ObjectId("nothex") })`)).toMatch(/24-char hex/);
    expect(parseErr(`db.x.find({ _id: ObjectId() })`)).toMatch(/without an argument/);
  });

  it("lifts ISODate to extJSON $date", () => {
    const op = parseOk(`db.x.insertOne({ at: ISODate("2026-01-01T00:00:00.000Z") })`);
    expect((op as { document: { at: unknown } }).document.at).toEqual({
      $date: "2026-01-01T00:00:00.000Z",
    });
  });

  it("lifts new Date(...)", () => {
    const op = parseOk(`db.x.insertOne({ at: new Date("2026-05-22T00:00:00.000Z") })`);
    expect((op as { document: { at: unknown } }).document.at).toEqual({
      $date: "2026-05-22T00:00:00.000Z",
    });
  });
});

describe("mongoDsl: literals", () => {
  it("handles strings, numbers, booleans, null", () => {
    const op = parseOk(
      `db.x.insertOne({ s: "x", n: -42, f: 3.14, b: true, no: false, nil: null })`,
    );
    expect((op as { document: unknown }).document).toEqual({
      s: "x",
      n: -42,
      f: 3.14,
      b: true,
      no: false,
      nil: null,
    });
  });

  it("handles single and double-quoted strings", () => {
    const op = parseOk(`db.x.find({ a: 'one', b: "two" })`);
    expect((op as { filter: unknown }).filter).toEqual({ a: "one", b: "two" });
  });

  it("handles escape sequences", () => {
    const op = parseOk(`db.x.find({ s: "line1\\nline2\\t\\"q\\"" })`);
    expect((op as { filter: { s: string } }).filter.s).toBe('line1\nline2\t"q"');
  });

  it("handles trailing commas in objects and arrays", () => {
    const op = parseOk(`db.x.insertMany([{ a: 1, }, { b: 2, },])`);
    expect((op as { documents: unknown }).documents).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("handles regex literal", () => {
    const op = parseOk(`db.x.find({ name: /^al.*/i })`);
    expect((op as { filter: unknown }).filter).toEqual({
      name: { $regex: "^al.*", $options: "i" },
    });
  });

  it("supports nested objects deep", () => {
    const op = parseOk(`db.x.find({ a: { b: { c: { d: 1, e: [1, 2, { f: "g" }] } } } })`);
    expect((op as { filter: unknown }).filter).toEqual({
      a: { b: { c: { d: 1, e: [1, 2, { f: "g" }] } } },
    });
  });
});

describe("mongoDsl: comments and whitespace", () => {
  it("strips line comments", () => {
    const op = parseOk(`
      // get active users
      db.users.find({ active: true }) // chained later? no.
    `);
    expect(op).toEqual({ op: "find", collection: "users", filter: { active: true } });
  });

  it("strips block comments", () => {
    const op = parseOk(`db.users./* hi */ find({ /* k */ a: 1 })`);
    expect(op).toEqual({ op: "find", collection: "users", filter: { a: 1 } });
  });

  it("tolerates trailing semicolon", () => {
    const op = parseOk(`db.users.find({});`);
    expect(op).toEqual({ op: "find", collection: "users", filter: {} });
  });
});

describe("mongoDsl: errors", () => {
  it("rejects non-db root", () => {
    expect(parseErr(`users.find({})`)).toMatch(/start with 'db'/);
  });

  it("rejects unknown method", () => {
    expect(parseErr(`db.users.frobnicate({})`)).toMatch(/unknown method/);
  });

  it("rejects unknown chain method", () => {
    expect(parseErr(`db.users.find({}).pretty()`)).toMatch(/unknown chain method/);
  });

  it("reports position on syntax error", () => {
    const err = parseErr(`db.users.find({ a:: 1 })`);
    expect(err).toMatch(/line 1, col \d+/);
  });

  it("rejects multiple statements", () => {
    expect(parseErr(`db.users.find({}) db.x.find({})`)).toMatch(/end of input/);
  });

  it("rejects bare identifier in expression", () => {
    expect(parseErr(`db.users.find({ a: foo })`)).toMatch(/helpers must be called like ObjectId/);
  });
});

describe("mongoDsl: additional ctor lifting", () => {
  it("lifts NumberLong / NumberInt from numbers", () => {
    const op = parseOk(`db.x.insertOne({ a: NumberLong(42), b: NumberInt(7) })`);
    expect((op as { document: unknown }).document).toEqual({ a: 42, b: 7 });
  });

  it("lifts NumberLong from a numeric string", () => {
    const op = parseOk(`db.x.insertOne({ a: NumberLong("1234") })`);
    expect((op as { document: { a: unknown } }).document.a).toBe(1234);
  });

  it("rejects NumberLong with a non-numeric string", () => {
    expect(parseErr(`db.x.insertOne({ a: NumberLong("nope") })`)).toMatch(/invalid number/);
  });

  it("rejects NumberLong with the wrong arg type", () => {
    expect(parseErr(`db.x.insertOne({ a: NumberLong(true) })`)).toMatch(
      /expects a number or string/,
    );
  });

  it("lifts RegExp(pattern, flags)", () => {
    const op = parseOk(`db.x.find({ name: RegExp("^al.*", "i") })`);
    expect((op as { filter: unknown }).filter).toEqual({
      name: { $regex: "^al.*", $options: "i" },
    });
  });

  it("defaults RegExp flags to empty when omitted", () => {
    const op = parseOk(`db.x.find({ name: RegExp("^al.*") })`);
    expect((op as { filter: unknown }).filter).toEqual({
      name: { $regex: "^al.*", $options: "" },
    });
  });

  it("rejects RegExp with non-string args", () => {
    expect(parseErr(`db.x.find({ name: RegExp(1, 2) })`)).toMatch(/RegExp\(pattern, flags\)/);
  });

  it("synthesizes a $date for bare ISODate() / Date()", () => {
    const op = parseOk(`db.x.insertOne({ at: ISODate() })`);
    const at = (op as { document: { at: { $date: string } } }).document.at;
    // The synthesized value is just `new Date().toISOString()`; we don't pin
    // the exact value, only that it's a valid ISO string.
    expect(typeof at.$date).toBe("string");
    expect(Number.isNaN(new Date(at.$date).getTime())).toBe(false);
  });

  it("rejects ISODate with a non-string argument", () => {
    expect(parseErr(`db.x.insertOne({ at: ISODate(42) })`)).toMatch(/expects an ISO-8601 string/);
  });

  it("rejects ISODate with an unparseable date string", () => {
    expect(parseErr(`db.x.insertOne({ at: ISODate("not-a-date") })`)).toMatch(
      /invalid date string/,
    );
  });

  it("rejects an unknown constructor", () => {
    expect(parseErr(`db.x.insertOne({ a: Frobnicator(1) })`)).toMatch(/unknown constructor/);
  });
});

describe("mongoDsl: find with projection arg", () => {
  it("captures the second arg as projection", () => {
    const op = parseOk(`db.users.find({ active: true }, { name: 1, _id: 0 })`);
    expect(op).toEqual({
      op: "find",
      collection: "users",
      filter: { active: true },
      projection: { name: 1, _id: 0 },
    });
  });

  it("captures findOne's projection arg too", () => {
    const op = parseOk(`db.users.findOne({}, { name: 1 })`);
    expect(op).toEqual({
      op: "find_one",
      collection: "users",
      filter: {},
      projection: { name: 1 },
    });
  });

  it("rejects find with more than two args", () => {
    expect(parseErr(`db.users.find({}, {}, {})`)).toMatch(/at most 2 arguments/);
  });

  it("rejects findOne with more than two args", () => {
    expect(parseErr(`db.users.findOne({}, {}, {})`)).toMatch(/at most 2 arguments/);
  });

  it("rejects insertMany given a non-array argument", () => {
    expect(parseErr(`db.users.insertMany({ name: "a" })`)).toMatch(/array of documents/);
  });

  it("rejects insertOne with wrong arity", () => {
    expect(parseErr(`db.users.insertOne()`)).toMatch(/expects 1/);
  });

  it("rejects updateMany with wrong arity", () => {
    expect(parseErr(`db.users.updateMany({})`)).toMatch(/expects 2/);
  });

  it("rejects deleteMany with wrong arity", () => {
    expect(parseErr(`db.users.deleteMany()`)).toMatch(/expects 1/);
  });
});

describe("mongoDsl: chain methods", () => {
  it("accepts .projection() as an alias for .project()", () => {
    const op = parseOk(`db.users.find({}).projection({ name: 1 })`);
    expect((op as { projection: unknown }).projection).toEqual({ name: 1 });
  });

  it("rejects non-integer limit", () => {
    expect(parseErr(`db.users.find({}).limit(1.5)`)).toMatch(/integer/);
  });

  it("rejects non-integer skip", () => {
    expect(parseErr(`db.users.find({}).skip(1.5)`)).toMatch(/integer/);
  });

  it("rejects sort with wrong arity", () => {
    expect(parseErr(`db.users.find({}).sort({}, {})`)).toMatch(/sort\(\) expects 1/);
  });

  it("rejects project with wrong arity", () => {
    expect(parseErr(`db.users.find({}).project({}, {})`)).toMatch(/project\(\) expects 1/);
  });
});

describe("mongoDsl: lexer edge cases", () => {
  it("parses numbers with exponents", () => {
    const op = parseOk(`db.x.insertOne({ a: 1e3, b: 2.5e-2, c: 1E+2 })`);
    expect((op as { document: unknown }).document).toEqual({ a: 1000, b: 0.025, c: 100 });
  });

  it("allows numeric keys in object literals", () => {
    const op = parseOk(`db.x.find({ 0: 1, 1: 2 })`);
    expect((op as { filter: unknown }).filter).toEqual({ "0": 1, "1": 2 });
  });

  it("accepts undefined as null", () => {
    const op = parseOk(`db.x.insertOne({ a: undefined })`);
    expect((op as { document: { a: unknown } }).document.a).toBeNull();
  });

  it("handles a regex with a character class containing /", () => {
    const op = parseOk(`db.x.find({ p: /[a-z/]+/g })`);
    expect((op as { filter: unknown }).filter).toEqual({
      p: { $regex: "[a-z/]+", $options: "g" },
    });
  });

  it("rejects unterminated strings", () => {
    expect(parseErr(`db.x.find({ a: "unterminated })`)).toMatch(/unterminated string/);
  });

  it("rejects strings broken by a newline", () => {
    expect(parseErr(`db.x.find({ a: "bro\nken" })`)).toMatch(/unterminated string/);
  });

  it("rejects unterminated regex", () => {
    expect(parseErr(`db.x.find({ a: /no-end`)).toMatch(/unterminated regex/);
  });

  it("rejects unterminated block comments", () => {
    expect(parseErr(`db.x.find({ /* never closed`)).toMatch(/unterminated .* comment/);
  });

  it("rejects unknown escape sequences", () => {
    expect(parseErr(`db.x.find({ a: "\\q" })`)).toMatch(/unknown escape/);
  });

  it("rejects unexpected characters", () => {
    expect(parseErr(`db.x.find({ a: @ })`)).toMatch(/unexpected character/);
  });

  it("rejects a unary minus before a non-number", () => {
    expect(parseErr(`db.x.find({ a: -"foo" })`)).toMatch(/expected number after '-'/);
  });
});

describe("mongoDsl: use prefix edge cases", () => {
  it("does not attach a database when use is present but op is runCommand", () => {
    const op = parseOk(`use admin; db.runCommand({ ping: 1 })`);
    expect(op).toEqual({ op: "run_command", value: { ping: 1 } });
  });

  it("attaches database even with chained methods", () => {
    const op = parseOk(`use shop; db.users.find({}).limit(5)`);
    expect(op).toEqual({
      op: "find",
      collection: "users",
      filter: {},
      limit: 5,
      database: "shop",
    });
  });
});

describe("mongoDsl: ParseResult error shape", () => {
  it("returns { ok: false, error } rather than throwing", () => {
    const r: ParseResult = parseMongoDsl(`not-a-query`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(typeof r.error).toBe("string");
  });

  it("returns { ok: true, op } for a valid query", () => {
    const r: ParseResult = parseMongoDsl(`db.users.find({})`);
    expect(r.ok).toBe(true);
  });
});
