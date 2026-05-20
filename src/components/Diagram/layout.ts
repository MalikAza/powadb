import type { DiagramDoc, DiagramTable } from "./types";

const NODE_WIDTH = 240;
const ROW_HEIGHT = 22;
const HEADER_HEIGHT = 32;

export function estimateNodeHeight(table: DiagramTable): number {
  return HEADER_HEIGHT + table.columns.length * ROW_HEIGHT + 8;
}

/**
 * Lay tables out using elkjs (lazy-imported). For very small graphs we use a
 * simple grid so the user doesn't pay the elk init cost on every open.
 */
export async function layoutDoc(doc: DiagramDoc): Promise<DiagramDoc> {
  if (doc.tables.length === 0) return doc;
  if (doc.tables.length <= 4) return gridLayout(doc);

  const { default: ELK } = await import("elkjs/lib/elk.bundled.js");
  const elk = new ELK();

  const elkGraph = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.layered.spacing.nodeNodeBetweenLayers": "160",
      "elk.spacing.nodeNode": "120",
    },
    children: doc.tables.map((t) => ({
      id: t.id,
      width: NODE_WIDTH,
      height: estimateNodeHeight(t),
    })),
    edges: doc.edges.map((e) => ({
      id: e.id,
      sources: [e.source],
      targets: [e.target],
    })),
  };

  const laid = await elk.layout(elkGraph);
  const positions = new Map<string, { x: number; y: number }>();
  for (const child of laid.children ?? []) {
    if (child.id && typeof child.x === "number" && typeof child.y === "number") {
      positions.set(child.id, { x: child.x, y: child.y });
    }
  }

  return {
    ...doc,
    tables: doc.tables.map((t) => ({
      ...t,
      position: positions.get(t.id) ?? t.position,
    })),
  };
}

function gridLayout(doc: DiagramDoc): DiagramDoc {
  const cols = Math.ceil(Math.sqrt(doc.tables.length));
  const colWidth = NODE_WIDTH + 160;
  let rowY = 0;
  let rowMax = 0;
  return {
    ...doc,
    tables: doc.tables.map((t, i) => {
      const col = i % cols;
      if (col === 0 && i > 0) {
        rowY += rowMax + 120;
        rowMax = 0;
      }
      const height = estimateNodeHeight(t);
      if (height > rowMax) rowMax = height;
      return { ...t, position: { x: col * colWidth, y: rowY } };
    }),
  };
}
