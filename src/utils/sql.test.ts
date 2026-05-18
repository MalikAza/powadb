import { describe, expect, it } from "vitest";
import {
  escapeStringLiteral,
  type Filter,
  filterToSql,
  parseFilter,
  quoteIdent,
  quoteTable,
} from "./sql";

describe("quoteIdent", () => {
  it("uses backticks for mysql", () => {
    expect(quoteIdent("users", "mysql")).toBe("`users`");
  });

  it("uses double quotes for postgres", () => {
    expect(quoteIdent("users", "postgres")).toBe('"users"');
  });

  it("escapes embedded backticks for mysql", () => {
    expect(quoteIdent("we`ird", "mysql")).toBe("`we``ird`");
  });

  it("escapes embedded double quotes for postgres", () => {
    expect(quoteIdent('we"ird', "postgres")).toBe('"we""ird"');
  });
});

describe("quoteTable", () => {
  it("drops the schema for mysql", () => {
    expect(quoteTable("public", "users", "mysql")).toBe("`users`");
  });

  it("schema-qualifies for postgres", () => {
    expect(quoteTable("public", "users", "postgres")).toBe('"public"."users"');
  });
});

describe("escapeStringLiteral", () => {
  it("wraps in single quotes and doubles embedded quotes", () => {
    expect(escapeStringLiteral("o'reilly")).toBe("'o''reilly'");
    expect(escapeStringLiteral("plain")).toBe("'plain'");
  });
});

describe("parseFilter", () => {
  it("returns null for empty input", () => {
    expect(parseFilter("")).toBeNull();
    expect(parseFilter("   ")).toBeNull();
  });

  it("recognizes null sentinels", () => {
    expect(parseFilter("null")).toEqual({ kind: "is_null" });
    expect(parseFilter("IS NULL")).toEqual({ kind: "is_null" });
    expect(parseFilter("not null")).toEqual({ kind: "is_not_null" });
    expect(parseFilter("IS NOT NULL")).toEqual({ kind: "is_not_null" });
  });

  it("recognizes comparison operators, longest match first", () => {
    expect(parseFilter(">=5")).toEqual({ kind: "compare", op: ">=", value: "5" });
    expect(parseFilter("<= 5")).toEqual({ kind: "compare", op: "<=", value: "5" });
    expect(parseFilter("!=foo")).toEqual({ kind: "compare", op: "!=", value: "foo" });
    expect(parseFilter("> 5")).toEqual({ kind: "compare", op: ">", value: "5" });
    expect(parseFilter("=42")).toEqual({ kind: "compare", op: "=", value: "42" });
  });

  it("falls back to a like filter", () => {
    expect(parseFilter("alice")).toEqual({ kind: "like", value: "alice" });
  });

  it("treats an operator with no value as no filter", () => {
    expect(parseFilter("=")).toBeNull();
    expect(parseFilter("= ")).toBeNull();
    expect(parseFilter(">")).toBeNull();
    expect(parseFilter(">=")).toBeNull();
    expect(parseFilter("!=")).toBeNull();
  });
});

describe("filterToSql", () => {
  it("renders IS NULL / IS NOT NULL", () => {
    expect(filterToSql("col", { kind: "is_null" }, "postgres")).toBe('"col" IS NULL');
    expect(filterToSql("col", { kind: "is_not_null" }, "mysql")).toBe("`col` IS NOT NULL");
  });

  it("inlines numeric comparisons without quotes", () => {
    const f: Filter = { kind: "compare", op: ">=", value: "10" };
    expect(filterToSql("age", f, "postgres")).toBe('"age" >= 10');
  });

  it("quotes string comparisons and doubles single quotes", () => {
    const f: Filter = { kind: "compare", op: "=", value: "o'reilly" };
    expect(filterToSql("name", f, "postgres")).toBe("\"name\" = 'o''reilly'");
  });

  it("renders postgres LIKE as ILIKE on TEXT-cast column", () => {
    const f: Filter = { kind: "like", value: "ali" };
    expect(filterToSql("name", f, "postgres")).toBe("CAST(\"name\" AS TEXT) ILIKE '%ali%'");
  });

  it("renders mysql LIKE on CHAR-cast column", () => {
    const f: Filter = { kind: "like", value: "ali" };
    expect(filterToSql("name", f, "mysql")).toBe("CAST(`name` AS CHAR) LIKE '%ali%'");
  });

  it("treats negative numbers and decimals as numeric", () => {
    expect(filterToSql("x", { kind: "compare", op: "<", value: "-1.5" }, "postgres")).toBe(
      '"x" < -1.5',
    );
  });
});
