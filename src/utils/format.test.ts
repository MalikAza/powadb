import { describe, expect, it } from "vitest";
import type { QueryResult } from "../types";
import { toCsv, toJson, toTsv } from "./format";

const sample: QueryResult = {
  columns: [
    { name: "id", type_name: "INT4" },
    { name: "name", type_name: "TEXT" },
    { name: "meta", type_name: "JSON" },
  ],
  rows: [
    [1, "Alice", { age: 30 }],
    [2, 'Bob, the\n"Builder"', null],
    [3, null, { tags: ["a", "b"] }],
  ],
  elapsed_ms: 1,
};

describe("toTsv", () => {
  it("emits a header row + tab-separated body", () => {
    const out = toTsv(sample);
    const lines = out.split("\n");
    expect(lines[0]).toBe("id\tname\tmeta");
    expect(lines).toHaveLength(4);
  });

  it("replaces embedded tabs and newlines with spaces", () => {
    const out = toTsv(sample);
    const lines = out.split("\n");
    expect(lines[2]).not.toContain("\t\t");
    expect(lines[2]).toContain("Bob, the");
    expect(lines[2]).not.toMatch(/\n/);
  });

  it("renders null as empty string", () => {
    const out = toTsv(sample);
    expect(out.split("\n")[3]).toMatch(/^3\t\t/);
  });
});

describe("toCsv", () => {
  it("quotes fields containing commas, quotes, or newlines and doubles embedded quotes", () => {
    const out = toCsv(sample);
    expect(out).toContain('2,"Bob, the\n""Builder""",');
  });

  it("renders the header row unquoted when columns are simple", () => {
    const out = toCsv(sample);
    expect(out.split("\n")[0]).toBe("id,name,meta");
  });

  it("leaves simple fields unquoted and quotes JSON-looking values", () => {
    const out = toCsv(sample);
    expect(out.split("\n")[1]).toBe('1,Alice,"{""age"":30}"');
  });
});

describe("toJson", () => {
  it("serializes rows as objects keyed by column name", () => {
    const out = toJson(sample);
    const parsed = JSON.parse(out);
    expect(parsed).toHaveLength(3);
    expect(parsed[0]).toEqual({ id: 1, name: "Alice", meta: { age: 30 } });
    expect(parsed[2]).toEqual({ id: 3, name: null, meta: { tags: ["a", "b"] } });
  });

  it("pretty-prints with 2-space indent", () => {
    const out = toJson(sample);
    expect(out).toContain("\n  ");
  });
});
