import { describe, expect, it } from "vitest";
import { computeContainerOrder } from "./reorder";

const item = (id: string, name: string, position: number | null = null) => ({
  id,
  name,
  position,
});

describe("computeContainerOrder", () => {
  it("materializes the alphabetical order on first drag in a container", () => {
    // Never-dragged container: all positions null, visual order is by name.
    const items = [item("c", "Charlie"), item("a", "Alpha"), item("b", "Beta")];
    // Drag Charlie to the top.
    expect(computeContainerOrder(items, "c", 0)).toEqual(["c", "a", "b"]);
  });

  it("reorders within an already positioned container", () => {
    const items = [item("a", "Alpha", 0), item("b", "Beta", 1), item("c", "Charlie", 2)];
    expect(computeContainerOrder(items, "a", 2)).toEqual(["b", "c", "a"]);
  });

  it("inserts a cross-container item at the requested index", () => {
    // Moved item is absent from the target container.
    const items = [item("a", "Alpha", 0), item("b", "Beta", 1)];
    expect(computeContainerOrder(items, "x", 1)).toEqual(["a", "x", "b"]);
  });

  it("sorts positioned items before alphabetical null ones", () => {
    // Zeta was dragged to the top earlier; Alpha/Mu never moved.
    const items = [item("m", "Mu"), item("z", "Zeta", 0), item("a", "Alpha")];
    expect(computeContainerOrder(items, "x", 3)).toEqual(["z", "a", "m", "x"]);
  });

  it("clamps out-of-range target indices", () => {
    const items = [item("a", "Alpha", 0), item("b", "Beta", 1)];
    expect(computeContainerOrder(items, "b", 99)).toEqual(["a", "b"]);
    expect(computeContainerOrder(items, "b", -5)).toEqual(["b", "a"]);
  });

  it("appends to an empty container", () => {
    expect(computeContainerOrder([], "x", 0)).toEqual(["x"]);
  });
});
