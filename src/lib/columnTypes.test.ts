import { describe, expect, it } from "vitest";
import type { Column, DbKind } from "@/types";
import { isByteaColumn, isGeoColumn } from "./columnTypes";

const col = (type_name: string): Column => ({ name: "x", type_name });

describe("isGeoColumn", () => {
  it("matches geometry on postgres", () => {
    expect(isGeoColumn("postgres", col("geometry"))).toBe(true);
  });

  it("matches geography on postgres", () => {
    expect(isGeoColumn("postgres", col("geography"))).toBe(true);
  });

  it("is case-insensitive on the type name", () => {
    expect(isGeoColumn("postgres", col("GEOMETRY"))).toBe(true);
    expect(isGeoColumn("postgres", col("Geography"))).toBe(true);
  });

  it("rejects non-postgres engines", () => {
    expect(isGeoColumn("mysql", col("geometry"))).toBe(false);
    expect(isGeoColumn("sqlite", col("geometry"))).toBe(false);
    expect(isGeoColumn("mongo" as DbKind, col("geometry"))).toBe(false);
  });

  it("rejects unrelated type names", () => {
    expect(isGeoColumn("postgres", col("point"))).toBe(false);
    expect(isGeoColumn("postgres", col("text"))).toBe(false);
  });
});

describe("isByteaColumn", () => {
  it("matches BYTEA on postgres", () => {
    expect(isByteaColumn("postgres", col("BYTEA"))).toBe(true);
  });

  it("is case-insensitive on the type name", () => {
    expect(isByteaColumn("postgres", col("bytea"))).toBe(true);
    expect(isByteaColumn("postgres", col("ByTeA"))).toBe(true);
  });

  it("rejects non-postgres engines even with bytea type", () => {
    expect(isByteaColumn("mysql", col("BYTEA"))).toBe(false);
    expect(isByteaColumn("sqlite", col("BYTEA"))).toBe(false);
  });

  it("rejects non-bytea types on postgres", () => {
    expect(isByteaColumn("postgres", col("blob"))).toBe(false);
    expect(isByteaColumn("postgres", col("varbinary"))).toBe(false);
  });
});
