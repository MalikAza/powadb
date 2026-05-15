import { describe, expect, it } from "vitest";
import { layoutDoc } from "./layout";
import type { DiagramDoc } from "./types";

function makeDoc(tableCount: number): DiagramDoc {
  return {
    version: 1,
    engine: "sqlite",
    tables: Array.from({ length: tableCount }, (_, i) => ({
      id: `t${i}`,
      schema: "main",
      name: `t${i}`,
      columns: [
        {
          id: `t${i}.id`,
          name: "id",
          dataType: "integer",
          nullable: false,
          isPk: true,
          isFk: false,
          defaultValue: null,
        },
      ],
      position: { x: 0, y: 0 },
    })),
    edges: [],
  };
}

describe("layoutDoc", () => {
  it("returns the same doc when there are zero tables", async () => {
    const doc = makeDoc(0);
    const out = await layoutDoc(doc);
    expect(out).toBe(doc);
  });

  it("assigns distinct positions to every table in a small grid", async () => {
    const doc = makeDoc(4);
    const out = await layoutDoc(doc);
    expect(out.tables).toHaveLength(4);
    const positions = out.tables.map((t) => `${t.position.x},${t.position.y}`);
    expect(new Set(positions).size).toBe(4);
  });

  it("places tables on multiple rows when the grid wraps", async () => {
    const doc = makeDoc(4);
    const out = await layoutDoc(doc);
    const yValues = new Set(out.tables.map((t) => t.position.y));
    expect(yValues.size).toBeGreaterThan(1);
  });
});
