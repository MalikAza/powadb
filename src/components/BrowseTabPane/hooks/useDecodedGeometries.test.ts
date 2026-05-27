import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Column, DbKind, QueryResult } from "@/types";
import { geomKey } from "../helpers";

type DecodedEntry = { geojson: string } | null;

const ipcMock = {
  decodeGeometries: vi.fn<(connectionId: string, hexes: string[]) => Promise<DecodedEntry[]>>(),
};

vi.mock("@/ipc", () => ({
  ipc: ipcMock,
}));

const { useDecodedGeometries } = await import("./useDecodedGeometries");

const geomCol = (name: string): Column => ({ name, type_name: "geometry" });
const textCol = (name: string): Column => ({ name, type_name: "text" });

function makeResult(over: Partial<QueryResult> = {}): QueryResult {
  return {
    columns: [],
    rows: [],
    elapsed_ms: 0,
    ...over,
  };
}

beforeEach(() => {
  ipcMock.decodeGeometries.mockReset();
});

describe("useDecodedGeometries", () => {
  it("returns an empty map when no geometry columns are present", () => {
    const result = makeResult({ columns: [textCol("name")], rows: [["alice"]] });
    const hook = renderHook(() => useDecodedGeometries("c1", "postgres", result));
    expect(hook.result.current.size).toBe(0);
    expect(ipcMock.decodeGeometries).not.toHaveBeenCalled();
  });

  it("skips non-postgres engines without calling ipc", () => {
    const result = makeResult({
      columns: [geomCol("geom")],
      rows: [["\\x0101"]],
    });
    const hook = renderHook(() => useDecodedGeometries("c1", "mysql" as DbKind, result));
    expect(hook.result.current.size).toBe(0);
    expect(ipcMock.decodeGeometries).not.toHaveBeenCalled();
  });

  it("ignores empty-string and non-string geometry cells", () => {
    const result = makeResult({
      columns: [geomCol("geom")],
      rows: [[""], [null]],
    });
    renderHook(() => useDecodedGeometries("c1", "postgres", result));
    expect(ipcMock.decodeGeometries).not.toHaveBeenCalled();
  });

  it("decodes the coordsJson into the keyed map", async () => {
    ipcMock.decodeGeometries.mockResolvedValue([
      { geojson: '{"type":"Point","coordinates":[1,2]}' } as DecodedEntry,
    ]);
    const result = makeResult({
      columns: [geomCol("geom")],
      rows: [["\\x0101000000"]],
    });
    const hook = renderHook(() => useDecodedGeometries("c1", "postgres", result));
    await waitFor(() => expect(hook.result.current.size).toBe(1));
    const decoded = hook.result.current.get(geomKey(0, 0));
    expect(decoded?.coordsJson).toBe("[1,2]");
  });

  it("falls back to the raw geojson when JSON parsing fails", async () => {
    ipcMock.decodeGeometries.mockResolvedValue([{ geojson: "not-json" } as DecodedEntry]);
    const result = makeResult({
      columns: [geomCol("geom")],
      rows: [["\\x0101"]],
    });
    const hook = renderHook(() => useDecodedGeometries("c1", "postgres", result));
    await waitFor(() => expect(hook.result.current.size).toBe(1));
    expect(hook.result.current.get(geomKey(0, 0))?.coordsJson).toBe("not-json");
  });

  it("renders 'null' coordsJson when the decoded geojson has no coordinates field", async () => {
    ipcMock.decodeGeometries.mockResolvedValue([
      { geojson: '{"type":"GeometryCollection","geometries":[]}' } as DecodedEntry,
    ]);
    const result = makeResult({
      columns: [geomCol("geom")],
      rows: [["\\x07"]],
    });
    const hook = renderHook(() => useDecodedGeometries("c1", "postgres", result));
    await waitFor(() => expect(hook.result.current.size).toBe(1));
    expect(hook.result.current.get(geomKey(0, 0))?.coordsJson).toBe("null");
  });

  it("skips null entries returned by the ipc call", async () => {
    ipcMock.decodeGeometries.mockResolvedValue([
      null,
      { geojson: '{"coordinates":[3,4]}' } as DecodedEntry,
    ]);
    const result = makeResult({
      columns: [geomCol("a"), geomCol("b")],
      rows: [["\\x01", "\\x02"]],
    });
    const hook = renderHook(() => useDecodedGeometries("c1", "postgres", result));
    await waitFor(() => expect(hook.result.current.size).toBe(1));
    expect(hook.result.current.get(geomKey(0, 0))).toBeUndefined();
    expect(hook.result.current.get(geomKey(0, 1))?.coordsJson).toBe("[3,4]");
  });

  it("clears the map when the ipc call rejects", async () => {
    ipcMock.decodeGeometries.mockRejectedValue(new Error("boom"));
    const result = makeResult({
      columns: [geomCol("geom")],
      rows: [["\\x0101"]],
    });
    const hook = renderHook(() => useDecodedGeometries("c1", "postgres", result));
    // wait for the rejected promise to resolve through the microtask queue
    await waitFor(() => expect(ipcMock.decodeGeometries).toHaveBeenCalled());
    expect(hook.result.current.size).toBe(0);
  });

  it("does not apply results from a cancelled call", async () => {
    let resolveCall: (entries: DecodedEntry[]) => void = () => {};
    ipcMock.decodeGeometries.mockImplementationOnce(
      () =>
        new Promise<DecodedEntry[]>((r) => {
          resolveCall = r;
        }),
    );
    const result = makeResult({
      columns: [geomCol("geom")],
      rows: [["\\x01"]],
    });
    const hook = renderHook(() => useDecodedGeometries("c1", "postgres", result));
    hook.unmount();
    resolveCall([{ geojson: '{"coordinates":[1]}' } as DecodedEntry]);
    await new Promise((r) => setTimeout(r, 0));
    expect(hook.result.current.size).toBe(0);
  });
});
