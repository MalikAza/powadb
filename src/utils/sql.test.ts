import { describe, expect, it } from "vitest";
import {
  escapeStringLiteral,
  type Filter,
  filterToSql,
  isFilterComplete,
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

describe("isFilterComplete", () => {
  it("is true for nullary ops", () => {
    expect(isFilterComplete({ kind: "is_null" })).toBe(true);
    expect(isFilterComplete({ kind: "is_not_null" })).toBe(true);
  });

  it("requires a value for compare and like", () => {
    expect(isFilterComplete({ kind: "compare", op: "=", value: "" })).toBe(false);
    expect(isFilterComplete({ kind: "compare", op: "=", value: "5" })).toBe(true);
    expect(isFilterComplete({ kind: "like", value: "  " })).toBe(false);
    expect(isFilterComplete({ kind: "like", value: "ali" })).toBe(true);
  });

  it("requires both bounds for between", () => {
    expect(isFilterComplete({ kind: "between", v1: "1", v2: "" })).toBe(false);
    expect(isFilterComplete({ kind: "between", v1: "", v2: "10" })).toBe(false);
    expect(isFilterComplete({ kind: "between", v1: "1", v2: "10" })).toBe(true);
  });

  it("requires at least one value for in", () => {
    expect(isFilterComplete({ kind: "in", values: [] })).toBe(false);
    expect(isFilterComplete({ kind: "in", values: ["1"] })).toBe(true);
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

  it("renders BETWEEN with mixed numeric / string bounds", () => {
    expect(filterToSql("age", { kind: "between", v1: "1", v2: "10" }, "postgres")).toBe(
      '"age" BETWEEN 1 AND 10',
    );
    expect(filterToSql("name", { kind: "between", v1: "a", v2: "m" }, "mysql")).toBe(
      "`name` BETWEEN 'a' AND 'm'",
    );
  });

  it("renders IN with mixed numeric / string values", () => {
    expect(filterToSql("id", { kind: "in", values: ["1", "2", "3"] }, "postgres")).toBe(
      '"id" IN (1, 2, 3)',
    );
    expect(filterToSql("name", { kind: "in", values: ["a", "b'c"] }, "mysql")).toBe(
      "`name` IN ('a', 'b''c')",
    );
  });
});
