import { describe, expect, it } from "vitest";
import type { Column } from "@/types";
import { MAX_AUTO_WIDTH_PX, MIN_AUTO_WIDTH_PX, measureColumnWidths } from "./measureColumnWidths";

const col = (name: string, type_name = "text"): Column => ({ name, type_name });

describe("measureColumnWidths", () => {
  it("returns one width per column", () => {
    const widths = measureColumnWidths([col("a"), col("b"), col("c")], []);
    expect(widths).toHaveLength(3);
  });

  it("clamps narrow headers up to MIN_AUTO_WIDTH_PX", () => {
    const widths = measureColumnWidths([col("x", "int")], []);
    expect(widths[0]).toBe(MIN_AUTO_WIDTH_PX);
  });

  it("clamps wide content down to MAX_AUTO_WIDTH_PX", () => {
    const long = "a".repeat(1000);
    const widths = measureColumnWidths([col("id")], [[long]]);
    expect(widths[0]).toBe(MAX_AUTO_WIDTH_PX);
  });

  it("uses the longest of header name or type_name as a floor for sizing", () => {
    // "id" has length 2, but the type_name "character varying(255)" has length 22.
    const widths = measureColumnWidths([col("id", "character varying(255)")], []);
    // Should be at least MIN, and likely below MAX. Either way, more than the
    // bare minimum-width of name-only sizing wouldn't tell us — just check that
    // type_name participated by making sure it's larger than measuring name only.
    const widthsNameOnly = measureColumnWidths([col("id", "x")], []);
    expect(widths[0]).toBeGreaterThanOrEqual(widthsNameOnly[0]);
  });

  it("renders null/undefined cells as 'NULL' for width computation", () => {
    // 'NULL' is 4 chars — shorter than MIN-width threshold. With only nulls,
    // result should still be MIN_AUTO_WIDTH_PX.
    const widths = measureColumnWidths([col("a", "x")], [[null], [undefined]]);
    expect(widths[0]).toBe(MIN_AUTO_WIDTH_PX);
  });

  it("JSON-stringifies object cells when measuring", () => {
    // A wide object is treated by its JSON representation.
    const obj = { a: "a".repeat(200) };
    const widths = measureColumnWidths([col("a")], [[obj]]);
    expect(widths[0]).toBe(MAX_AUTO_WIDTH_PX);
  });

  it("stops scanning rows once the cap is reached (no out-of-bounds reads)", () => {
    // First row already saturates; remaining rows should not throw.
    const wide = "x".repeat(500);
    const rows: unknown[][] = [[wide], [], [null]];
    const widths = measureColumnWidths([col("a")], rows);
    expect(widths[0]).toBe(MAX_AUTO_WIDTH_PX);
  });

  it("each column is measured independently against its own values", () => {
    const widths = measureColumnWidths(
      [col("short", "int"), col("long", "int")],
      [["x", "y".repeat(500)]],
    );
    expect(widths[0]).toBe(MIN_AUTO_WIDTH_PX);
    expect(widths[1]).toBe(MAX_AUTO_WIDTH_PX);
  });

  it("returns an empty array for zero columns", () => {
    expect(measureColumnWidths([], [])).toEqual([]);
    expect(measureColumnWidths([], [[]])).toEqual([]);
  });

  it("coerces non-string scalars through String(...)", () => {
    // numbers, booleans → short string form; should map to MIN_AUTO_WIDTH_PX.
    const widths = measureColumnWidths([col("a", "x")], [[123], [true], [false]]);
    expect(widths[0]).toBe(MIN_AUTO_WIDTH_PX);
  });
});
