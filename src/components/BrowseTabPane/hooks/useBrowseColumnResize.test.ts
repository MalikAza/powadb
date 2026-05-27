import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { columnDisplayKey, useColumnDisplay } from "@/stores/columnDisplay";
import type { Column } from "@/types";
import { useBrowseColumnResize } from "./useBrowseColumnResize";

const col = (name: string, type_name = "text"): Column => ({ name, type_name });

const COLS = [col("id", "int"), col("name", "text")];
const ROWS: readonly (readonly unknown[])[] = [
  [1, "alice"],
  [2, "bob"],
];

beforeEach(() => {
  useColumnDisplay.setState({ columnWidths: {}, byteaModes: {} });
});

afterEach(() => {
  useColumnDisplay.setState({ columnWidths: {}, byteaModes: {} });
});

describe("useBrowseColumnResize", () => {
  it("exposes one column width per column", () => {
    const { result } = renderHook(() => useBrowseColumnResize("c1", "public", "users", COLS, ROWS));
    expect(result.current.columnWidths).toHaveLength(COLS.length);
  });

  it("uses persisted widths from the store when present", () => {
    useColumnDisplay.setState({
      columnWidths: { [columnDisplayKey("c1", "public", "users", "id")]: 321 },
      byteaModes: {},
    });
    const { result } = renderHook(() => useBrowseColumnResize("c1", "public", "users", COLS, ROWS));
    expect(result.current.columnWidths[0]).toBe(321);
  });

  it("populates colRefs with one slot per column when refs are assigned", () => {
    const { result } = renderHook(() => useBrowseColumnResize("c1", "public", "users", COLS, ROWS));
    // Simulate React assigning DOM nodes to each <col> ref.
    const a = document.createElement("col") as HTMLTableColElement;
    const b = document.createElement("col") as HTMLTableColElement;
    result.current.colRefs.current[0] = a;
    result.current.colRefs.current[1] = b;
    expect(result.current.colRefs.current).toHaveLength(2);
  });

  it("resetWidth clears the persisted width entry for that column", async () => {
    useColumnDisplay.setState({
      columnWidths: {
        [columnDisplayKey("c1", "public", "users", "id")]: 321,
        [columnDisplayKey("c1", "public", "users", "name")]: 250,
      },
      byteaModes: {},
    });
    const { result } = renderHook(() => useBrowseColumnResize("c1", "public", "users", COLS, ROWS));
    // The clear runs inside a setTimeout(0) because useBrowseColumnResize wires
    // up onLiveResize — wait one macrotask for it to flush.
    await act(async () => {
      result.current.resetWidth(0);
      await new Promise((r) => setTimeout(r, 0));
    });
    const widths = useColumnDisplay.getState().columnWidths;
    expect(widths[columnDisplayKey("c1", "public", "users", "id")]).toBeUndefined();
    expect(widths[columnDisplayKey("c1", "public", "users", "name")]).toBe(250);
  });
});
