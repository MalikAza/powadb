import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { DiagFk } from "@/ipc";
import { columnDisplayKey } from "@/stores/columnDisplay";
import type { Column } from "@/types";
import { useBrowseDerived } from "./useBrowseDerived";

const col = (name: string, type_name = "text"): Column => ({ name, type_name });

const baseArgs = {
  cols: [] as Column[],
  fks: [] as DiagFk[],
  pkCols: null as string[] | null,
  kind: "postgres" as const,
  connId: "c1",
  schema: "public",
  table: "users",
  byteaModes: {} as Record<string, "hex" | "ulid" | "uuid">,
};

describe("useBrowseDerived", () => {
  it("builds colIndexByName from cols", () => {
    const cols = [col("id"), col("name"), col("email")];
    const { result } = renderHook(() => useBrowseDerived({ ...baseArgs, cols }));
    expect(result.current.colIndexByName.get("id")).toBe(0);
    expect(result.current.colIndexByName.get("email")).toBe(2);
    expect(result.current.colIndexByName.has("ghost")).toBe(false);
  });

  it("resolves pk column names to their indexes", () => {
    const cols = [col("a"), col("b"), col("c")];
    const { result } = renderHook(() =>
      useBrowseDerived({ ...baseArgs, cols, pkCols: ["a", "c"] }),
    );
    expect(result.current.pkColIndexes).toEqual([0, 2]);
  });

  it("returns null pkColIndexes when a pk col is missing from cols", () => {
    const cols = [col("a"), col("b")];
    const { result } = renderHook(() =>
      useBrowseDerived({ ...baseArgs, cols, pkCols: ["a", "ghost"] }),
    );
    expect(result.current.pkColIndexes).toBeNull();
  });

  it("returns null pkColIndexes when pkCols itself is null", () => {
    const { result } = renderHook(() => useBrowseDerived(baseArgs));
    expect(result.current.pkColIndexes).toBeNull();
  });

  it("indexes the first FK that references each column", () => {
    const fkA: DiagFk = {
      from_columns: ["a", "b"],
      to_columns: ["x", "y"],
    } as DiagFk;
    const fkB: DiagFk = {
      from_columns: ["a"],
      to_columns: ["z"],
    } as DiagFk;
    const { result } = renderHook(() =>
      useBrowseDerived({ ...baseArgs, cols: [col("a"), col("b")], fks: [fkA, fkB] }),
    );
    // First match wins for "a"; "b" only appears in fkA.
    expect(result.current.fkByColumn.get("a")).toBe(fkA);
    expect(result.current.fkByColumn.get("b")).toBe(fkA);
  });

  it("maps BYTEA columns to their stored mode and defaults missing entries to hex", () => {
    const cols = [col("plain"), col("id1", "BYTEA"), col("id2", "BYTEA")];
    const byteaModes = {
      [columnDisplayKey("c1", "public", "users", "id1")]: "ulid",
    } as Record<string, "hex" | "ulid" | "uuid">;
    const { result } = renderHook(() => useBrowseDerived({ ...baseArgs, cols, byteaModes }));
    expect(result.current.byteaColMode.has(0)).toBe(false);
    expect(result.current.byteaColMode.get(1)).toBe("ulid");
    expect(result.current.byteaColMode.get(2)).toBe("hex");
  });

  it("ignores BYTEA columns when kind is not postgres", () => {
    const cols = [col("id", "BYTEA")];
    const { result } = renderHook(() => useBrowseDerived({ ...baseArgs, cols, kind: "mysql" }));
    expect(result.current.byteaColMode.size).toBe(0);
  });
});
