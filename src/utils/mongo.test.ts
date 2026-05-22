import { describe, expect, it } from "vitest";
import type { EngineResult } from "../ipc";
import {
  engineResultToQueryResult,
  maybeObjectId,
  mongoDocumentsToQueryResult,
  mongoFiltersFromTab,
  mongoSortFromTab,
} from "./mongo";
import type { Filter } from "./sql";

describe("maybeObjectId", () => {
  it("wraps a 24-char hex string in { $oid }", () => {
    const hex = "507f1f77bcf86cd799439011";
    expect(maybeObjectId(hex)).toEqual({ $oid: hex });
  });

  it("accepts uppercase hex", () => {
    const hex = "AABBCCDDEEFF00112233AABB";
    expect(maybeObjectId(hex)).toEqual({ $oid: hex });
  });

  it("passes non-hex strings through unwrapped", () => {
    expect(maybeObjectId("alice")).toBe("alice");
    expect(maybeObjectId("123")).toBe("123");
    expect(maybeObjectId("507f1f77bcf86cd79943901")).toBe("507f1f77bcf86cd79943901"); // 23 chars
    expect(maybeObjectId("zzzf1f77bcf86cd799439011")).toBe("zzzf1f77bcf86cd799439011");
  });
});

describe("mongoFiltersFromTab", () => {
  const build = (filters: Record<string, Filter>) => mongoFiltersFromTab({ filters });

  it("returns {} for an empty filter map", () => {
    expect(build({})).toEqual({});
  });

  it("translates is_null / is_not_null", () => {
    expect(build({ a: { kind: "is_null" }, b: { kind: "is_not_null" } })).toEqual({
      a: { $eq: null },
      b: { $ne: null },
    });
  });

  it("translates equality compare to a bare value (no $eq wrapping)", () => {
    expect(build({ name: { kind: "compare", op: "=", value: "alice" } })).toEqual({
      name: "alice",
    });
  });

  it("translates each compare operator", () => {
    const ops = [
      { op: "!=" as const, expected: { $ne: 1 } },
      { op: ">" as const, expected: { $gt: 1 } },
      { op: "<" as const, expected: { $lt: 1 } },
      { op: ">=" as const, expected: { $gte: 1 } },
      { op: "<=" as const, expected: { $lte: 1 } },
    ];
    for (const { op, expected } of ops) {
      expect(build({ n: { kind: "compare", op, value: "1" } })).toEqual({ n: expected });
    }
  });

  it("coerces numeric, boolean, null, and empty scalars", () => {
    expect(build({ n: { kind: "compare", op: "=", value: "42" } })).toEqual({ n: 42 });
    expect(build({ n: { kind: "compare", op: "=", value: "-7" } })).toEqual({ n: -7 });
    expect(build({ n: { kind: "compare", op: "=", value: "3.14" } })).toEqual({ n: 3.14 });
    expect(build({ n: { kind: "compare", op: "=", value: "-2.5" } })).toEqual({ n: -2.5 });
    expect(build({ b: { kind: "compare", op: "=", value: "true" } })).toEqual({ b: true });
    expect(build({ b: { kind: "compare", op: "=", value: "false" } })).toEqual({ b: false });
    // null/empty coerce to null; the dispatcher drops null = clauses entirely.
    expect(build({ x: { kind: "compare", op: "=", value: "null" } })).toEqual({});
    expect(build({ x: { kind: "compare", op: "=", value: "  " } })).toEqual({});
    // But $ne against null IS emitted (the wrapping object is not null).
    expect(build({ x: { kind: "compare", op: "!=", value: "null" } })).toEqual({
      x: { $ne: null },
    });
  });

  it("coerces a hex string in the _id column to { $oid }", () => {
    const hex = "507f1f77bcf86cd799439011";
    expect(build({ _id: { kind: "compare", op: "=", value: hex } })).toEqual({
      _id: { $oid: hex },
    });
  });

  it("does NOT coerce a hex string for non-_id columns", () => {
    const hex = "507f1f77bcf86cd799439011";
    expect(build({ token: { kind: "compare", op: "=", value: hex } })).toEqual({ token: hex });
  });

  it("translates between with coerced bounds", () => {
    expect(build({ n: { kind: "between", v1: "1", v2: "10" } })).toEqual({
      n: { $gte: 1, $lte: 10 },
    });
  });

  it("translates in", () => {
    expect(build({ status: { kind: "in", values: ["ok", "1", "true"] } })).toEqual({
      status: { $in: ["ok", 1, true] },
    });
  });

  it("translates like with regex metacharacters escaped", () => {
    expect(build({ name: { kind: "like", value: "a.b*c+" } })).toEqual({
      name: { $regex: "a\\.b\\*c\\+", $options: "i" },
    });
  });

  it("ANDs filters at the top level (one key per field)", () => {
    const result = build({
      name: { kind: "compare", op: "=", value: "alice" },
      age: { kind: "compare", op: ">", value: "18" },
    });
    expect(result).toEqual({ name: "alice", age: { $gt: 18 } });
  });
});

describe("mongoSortFromTab", () => {
  it("returns undefined when no sort column is set", () => {
    expect(mongoSortFromTab({ sortCol: null, sortDir: "asc" })).toBeUndefined();
  });

  it("returns { field: 1 } for asc", () => {
    expect(mongoSortFromTab({ sortCol: "name", sortDir: "asc" })).toEqual({ name: 1 });
  });

  it("returns { field: -1 } for desc", () => {
    expect(mongoSortFromTab({ sortCol: "createdAt", sortDir: "desc" })).toEqual({ createdAt: -1 });
  });
});

describe("mongoDocumentsToQueryResult", () => {
  it("returns an _id-only synthetic column for empty input", () => {
    const r = mongoDocumentsToQueryResult([], 12);
    expect(r.columns).toEqual([{ name: "_id", type_name: "ObjectId" }]);
    expect(r.rows).toEqual([]);
    expect(r.elapsed_ms).toBe(12);
  });

  it("puts _id first and sorts the rest alphabetically", () => {
    const r = mongoDocumentsToQueryResult(
      [{ z: 1, _id: "507f1f77bcf86cd799439011", a: 2, m: 3 }],
      0,
    );
    expect(r.columns.map((c) => c.name)).toEqual(["_id", "a", "m", "z"]);
  });

  it("flags 24-hex strings in _id as ObjectId", () => {
    const r = mongoDocumentsToQueryResult([{ _id: "507f1f77bcf86cd799439011" }], 0);
    expect(r.columns[0]).toEqual({ name: "_id", type_name: "ObjectId" });
  });

  it("distinguishes int vs double", () => {
    const r = mongoDocumentsToQueryResult([{ _id: 1, n: 1, f: 1.5 }], 0);
    const col = (name: string) => r.columns.find((c) => c.name === name);
    expect(col("n")?.type_name).toBe("int");
    expect(col("f")?.type_name).toBe("double");
  });

  it("infers string / bool / array / object types", () => {
    const r = mongoDocumentsToQueryResult(
      [{ _id: 1, s: "x", b: true, arr: [1], obj: { k: "v" } }],
      0,
    );
    const col = (n: string) => r.columns.find((c) => c.name === n)?.type_name;
    expect(col("s")).toBe("string");
    expect(col("b")).toBe("bool");
    expect(col("arr")).toBe("array");
    expect(col("obj")).toBe("object");
  });

  it("joins mixed types in a column with ' | ' (sorted)", () => {
    const r = mongoDocumentsToQueryResult(
      [
        { _id: 1, v: "x" },
        { _id: 2, v: 7 },
      ],
      0,
    );
    const v = r.columns.find((c) => c.name === "v");
    expect(v?.type_name).toBe("int | string");
  });

  it("ignores null/undefined values when inferring types", () => {
    const r = mongoDocumentsToQueryResult(
      [
        { _id: 1, v: null },
        { _id: 2, v: undefined },
        { _id: 3, v: "x" },
      ],
      0,
    );
    expect(r.columns.find((c) => c.name === "v")?.type_name).toBe("string");
  });

  it("emits null cells for documents missing a field", () => {
    const r = mongoDocumentsToQueryResult([{ _id: 1, a: 1 }, { _id: 2 }], 0);
    expect(r.rows).toEqual([
      [1, 1],
      [2, null],
    ]);
  });

  it("preserves the union of fields across documents", () => {
    const r = mongoDocumentsToQueryResult(
      [
        { _id: 1, a: 1 },
        { _id: 2, b: 2 },
      ],
      0,
    );
    expect(r.columns.map((c) => c.name).sort()).toEqual(["_id", "a", "b"]);
  });

  it("preserves the elapsed_ms value", () => {
    expect(mongoDocumentsToQueryResult([{ _id: 1 }], 42).elapsed_ms).toBe(42);
  });
});

describe("engineResultToQueryResult", () => {
  it("passes tabular results through (columns/rows/elapsed)", () => {
    const er: EngineResult = {
      kind: "tabular",
      columns: [{ name: "id", type_name: "int" }],
      rows: [[1], [2]],
      elapsed_ms: 5,
    };
    expect(engineResultToQueryResult(er)).toEqual({
      columns: [{ name: "id", type_name: "int" }],
      rows: [[1], [2]],
      elapsed_ms: 5,
    });
  });

  it("converts documents to a tabular shape", () => {
    const er: EngineResult = {
      kind: "documents",
      docs: [{ _id: "507f1f77bcf86cd799439011", n: 1 }],
      elapsed_ms: 9,
    };
    const r = engineResultToQueryResult(er);
    expect(r.columns.map((c) => c.name)).toEqual(["_id", "n"]);
    expect(r.elapsed_ms).toBe(9);
  });

  it("synthesizes a 1-row rows_affected summary for affected", () => {
    const er: EngineResult = { kind: "affected", rows: 3, elapsed_ms: 2 };
    expect(engineResultToQueryResult(er)).toEqual({
      columns: [{ name: "rows_affected", type_name: "int" }],
      rows: [[3]],
      elapsed_ms: 2,
    });
  });
});
