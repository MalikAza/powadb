import { describe, expect, it } from "vitest";
import type { ByteaDisplayMode } from "@/lib/bytea";
import { columnDisplayKey } from "@/stores/columnDisplay";
import type { BrowseTab } from "@/stores/tabs";
import type { Column, SavedConnection } from "@/types";
import type { Filter } from "@/utils/sql";
import {
  buildFkFilters,
  buildRowData,
  buildWhereClause,
  byteaFilterToSql,
  cellDisplayString,
  formatPkValue,
  geomKey,
  parseMongoCellValue,
  pkLabelFor,
  rowKey,
} from "./helpers";

function makeConn(over: Partial<SavedConnection> = {}): SavedConnection {
  return {
    id: "c1",
    name: "Local",
    kind: "postgres",
    host: "localhost",
    port: 5432,
    database: "db",
    username: "u",
    ssl: false,
    folder_id: null,
    color: null,
    wg: null,
    ssh: null,
    ...over,
  };
}

function makeBrowseTab(over: Partial<BrowseTab> = {}): BrowseTab {
  return {
    id: "b1",
    connectionId: "c1",
    title: "users",
    result: null,
    error: null,
    loading: false,
    kind: "browse",
    schema: "public",
    table: "users",
    filters: {},
    sortCol: null,
    sortDir: "asc",
    limit: 100,
    offset: 0,
    pkCols: null,
    totalRows: null,
    ...over,
  };
}

const col = (name: string, type_name = "text"): Column => ({ name, type_name });

describe("geomKey", () => {
  it("formats row:col as a stable string", () => {
    expect(geomKey(2, 5)).toBe("2:5");
  });
});

describe("buildRowData", () => {
  it("zips columns with row values and skips excluded indexes", () => {
    const cols = [col("a"), col("b"), col("c")];
    const row = [1, 2, 3];
    const out = buildRowData(cols, row, new Set([1]));
    expect(out).toEqual([
      ["a", 1],
      ["c", 3],
    ]);
  });

  it("returns all entries when nothing is excluded", () => {
    const cols = [col("a"), col("b")];
    expect(buildRowData(cols, ["x", "y"], new Set())).toEqual([
      ["a", "x"],
      ["b", "y"],
    ]);
  });
});

describe("formatPkValue", () => {
  it("renders NULL for null and undefined", () => {
    expect(formatPkValue(null)).toBe("NULL");
    expect(formatPkValue(undefined)).toBe("NULL");
  });

  it("single-quotes strings and doubles embedded single quotes", () => {
    expect(formatPkValue("abc")).toBe("'abc'");
    expect(formatPkValue("O'Brien")).toBe("'O''Brien'");
  });

  it("renders numbers and booleans via String()", () => {
    expect(formatPkValue(42)).toBe("42");
    expect(formatPkValue(true)).toBe("true");
  });
});

describe("pkLabelFor", () => {
  it("returns null when no pk col indexes are provided", () => {
    expect(pkLabelFor(null, [], [])).toBeNull();
    expect(pkLabelFor([], [col("id")], [1])).toBeNull();
  });

  it("joins the pk columns with their formatted values", () => {
    const cols = [col("id"), col("name")];
    expect(pkLabelFor([0, 1], cols, [1, "alice"])).toBe("id = 1, name = 'alice'");
  });
});

describe("rowKey", () => {
  it("falls back to the row index when there is no pk", () => {
    expect(rowKey(null, [1, 2], 7)).toBe("i:7");
    expect(rowKey([], [1, 2], 3)).toBe("i:3");
  });

  it("derives a stable key from pk columns", () => {
    expect(rowKey([0, 2], ["a", "b", "c"], 0)).toBe("pk:a|c");
  });
});

describe("buildWhereClause", () => {
  it("returns an empty string when no filters are set", () => {
    expect(buildWhereClause(makeBrowseTab(), makeConn(), [], {})).toBe("");
  });

  it("joins complete filters with AND and prefixes with WHERE", () => {
    const filters: Record<string, Filter> = {
      age: { kind: "compare", op: ">", value: "18" },
      name: { kind: "like", value: "%alice%" },
    };
    const cols = [col("age", "int4"), col("name", "text")];
    const out = buildWhereClause(makeBrowseTab({ filters }), makeConn(), cols, {});
    expect(out.startsWith(" WHERE ")).toBe(true);
    expect(out).toContain('"age" > 18');
    expect(out).toContain(" AND ");
  });

  it("drops incomplete filters", () => {
    const filters: Record<string, Filter> = {
      name: { kind: "compare", op: "=", value: "   " },
      keep: { kind: "is_null" },
    };
    const cols = [col("name"), col("keep")];
    const out = buildWhereClause(makeBrowseTab({ filters }), makeConn(), cols, {});
    expect(out).toBe(' WHERE "keep" IS NULL');
  });

  it("routes BYTEA columns through byteaFilterToSql when the mode is ulid", () => {
    const conn = makeConn({ kind: "postgres" });
    const tab = makeBrowseTab({
      filters: {
        id: { kind: "compare", op: "=", value: "01ARZ3NDEKTSV4RRFFQ69G5FAV" },
      },
    });
    const cols = [col("id", "BYTEA")];
    const modes: Record<string, ByteaDisplayMode> = {
      [columnDisplayKey(conn.id, tab.schema, tab.table, "id")]: "ulid",
    };
    const out = buildWhereClause(tab, conn, cols, modes);
    expect(out).toMatch(/^ WHERE "id" = '\\x[0-9A-F]+'::bytea$/);
  });

  it("falls back to filterToSql when bytea mode is hex", () => {
    const conn = makeConn({ kind: "postgres" });
    const tab = makeBrowseTab({
      filters: { id: { kind: "is_null" } },
    });
    const cols = [col("id", "BYTEA")];
    expect(buildWhereClause(tab, conn, cols, {})).toBe(' WHERE "id" IS NULL');
  });
});

describe("byteaFilterToSql", () => {
  it("returns null for non-postgres engines", () => {
    const filter: Filter = { kind: "is_null" };
    expect(byteaFilterToSql("id", filter, "mysql", "ulid")).toBeNull();
  });

  it("formats is_null and is_not_null without literals", () => {
    expect(byteaFilterToSql("id", { kind: "is_null" }, "postgres", "ulid")).toBe('"id" IS NULL');
    expect(byteaFilterToSql("id", { kind: "is_not_null" }, "postgres", "ulid")).toBe(
      '"id" IS NOT NULL',
    );
  });

  it("renders a compare op when the value parses cleanly", () => {
    const out = byteaFilterToSql(
      "id",
      { kind: "compare", op: "=", value: "01ARZ3NDEKTSV4RRFFQ69G5FAV" },
      "postgres",
      "ulid",
    );
    expect(out).toMatch(/^"id" = '\\x[0-9A-F]+'::bytea$/);
  });

  it("returns null when the compare value is malformed", () => {
    expect(
      byteaFilterToSql("id", { kind: "compare", op: "=", value: "not-a-ulid" }, "postgres", "ulid"),
    ).toBeNull();
  });

  it("treats a 'like' filter as equality (no substring matching for bytea)", () => {
    const out = byteaFilterToSql(
      "id",
      { kind: "like", value: "01ARZ3NDEKTSV4RRFFQ69G5FAV" },
      "postgres",
      "ulid",
    );
    expect(out).toMatch(/^"id" = '\\x[0-9A-F]+'::bytea$/);
  });

  it("renders between when both endpoints are valid", () => {
    const v1 = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const v2 = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
    const out = byteaFilterToSql("id", { kind: "between", v1, v2 }, "postgres", "ulid");
    expect(out).toMatch(/^"id" BETWEEN '\\x[0-9A-F]+'::bytea AND '\\x[0-9A-F]+'::bytea$/);
  });

  it("returns null when one between endpoint is invalid", () => {
    const out = byteaFilterToSql(
      "id",
      { kind: "between", v1: "01ARZ3NDEKTSV4RRFFQ69G5FAV", v2: "junk" },
      "postgres",
      "ulid",
    );
    expect(out).toBeNull();
  });

  it("renders IN with every value when all parse", () => {
    const out = byteaFilterToSql(
      "id",
      {
        kind: "in",
        values: ["01ARZ3NDEKTSV4RRFFQ69G5FAV", "01ARZ3NDEKTSV4RRFFQ69G5FAW"],
      },
      "postgres",
      "ulid",
    );
    expect(out).toMatch(/^"id" IN \('\\x[0-9A-F]+'::bytea, '\\x[0-9A-F]+'::bytea\)$/);
  });

  it("returns null when IN has zero entries or any malformed value", () => {
    expect(byteaFilterToSql("id", { kind: "in", values: [] }, "postgres", "ulid")).toBeNull();
    expect(
      byteaFilterToSql(
        "id",
        { kind: "in", values: ["01ARZ3NDEKTSV4RRFFQ69G5FAV", "junk"] },
        "postgres",
        "ulid",
      ),
    ).toBeNull();
  });
});

describe("cellDisplayString", () => {
  it("returns null for null and undefined", () => {
    expect(cellDisplayString(null, undefined, undefined)).toBeNull();
    expect(cellDisplayString(undefined, undefined, undefined)).toBeNull();
  });

  it("prefers the decoded geometry coordsJson when present", () => {
    const decoded = { coordsJson: "[1,2]" } as never;
    expect(cellDisplayString("\\x00", decoded, "hex")).toBe("[1,2]");
  });

  it("formats bytea strings when a non-hex mode applies", () => {
    const raw = "\\x0123456789ABCDEF0123456789ABCDEF";
    const out = cellDisplayString(raw, undefined, "uuid");
    expect(out).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("falls back to String() when bytea format returns null (wrong length)", () => {
    const raw = "\\x00"; // 1 byte — can't be ULID/UUID
    expect(cellDisplayString(raw, undefined, "ulid")).toBe(raw);
  });

  it("JSON-stringifies object values", () => {
    expect(cellDisplayString({ a: 1 }, undefined, undefined)).toBe('{"a":1}');
  });

  it("stringifies scalar values", () => {
    expect(cellDisplayString(42, undefined, undefined)).toBe("42");
    expect(cellDisplayString(true, undefined, undefined)).toBe("true");
  });
});

describe("buildFkFilters", () => {
  const fk = {
    from_columns: ["author_id"],
    to_columns: ["id"],
  } as never;
  const cols = [col("id"), col("author_id"), col("title")];

  it("returns null when the fk references a column not in cols", () => {
    const fakeFk = { from_columns: ["ghost"], to_columns: ["id"] } as never;
    expect(buildFkFilters(fakeFk, [1], cols)).toBeNull();
  });

  it("skips null/undefined values and returns null when nothing is built", () => {
    expect(buildFkFilters(fk, [1, null, "t"], cols)).toBeNull();
  });

  it("builds a compare filter per matching column", () => {
    const out = buildFkFilters(fk, [1, 42, "t"], cols);
    expect(out).toEqual({
      id: { kind: "compare", op: "=", value: "42" },
    });
  });

  it("JSON-stringifies object values", () => {
    const obj = { $oid: "abc" };
    const out = buildFkFilters(fk, [1, obj, "t"], cols);
    expect(out?.id).toEqual({ kind: "compare", op: "=", value: JSON.stringify(obj) });
  });
});

describe("parseMongoCellValue", () => {
  it("returns null for empty input", () => {
    expect(parseMongoCellValue("")).toBeNull();
  });

  it("parses JSON when possible", () => {
    expect(parseMongoCellValue("42")).toBe(42);
    expect(parseMongoCellValue("true")).toBe(true);
    expect(parseMongoCellValue("null")).toBeNull();
    expect(parseMongoCellValue('{"$oid":"abc"}')).toEqual({ $oid: "abc" });
    expect(parseMongoCellValue('["a","b"]')).toEqual(["a", "b"]);
  });

  it("falls back to the raw string when JSON parsing fails", () => {
    expect(parseMongoCellValue("not json")).toBe("not json");
  });
});
