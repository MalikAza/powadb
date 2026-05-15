import { getNodesBounds, getViewportForBounds, type ReactFlowInstance } from "@xyflow/react";
import { toJpeg, toPng } from "html-to-image";
import { ipc } from "@/ipc";
import type { DbKind } from "@/types";
import type { DiagramDoc } from "./types";

export async function exportDocAsJson(doc: DiagramDoc, suggestedName: string): Promise<boolean> {
  const path = await ipc.pickSavePathWithFilter(`${stripExt(suggestedName)}.json`, "JSON", [
    "json",
  ]);
  if (!path) return false;
  await ipc.writeTextFile(path, JSON.stringify(doc, null, 2));
  return true;
}

export async function exportDocAsSql(doc: DiagramDoc, suggestedName: string): Promise<boolean> {
  const path = await ipc.pickSavePathWithFilter(`${stripExt(suggestedName)}.sql`, "SQL", ["sql"]);
  if (!path) return false;
  const ddl = await ipc.generateDiagramDdl(JSON.stringify(doc), doc.engine as DbKind);
  await ipc.writeTextFile(path, ddl);
  return true;
}

const EXPORT_WIDTH = 1600;
const EXPORT_HEIGHT = 1000;
const EXPORT_PADDING = 40;

function stripExt(name: string): string {
  return name.replace(/\.(json|sql|png|jpe?g|svg)$/i, "");
}

function findViewportEl(): HTMLElement {
  const el = document.querySelector(".react-flow__viewport") as HTMLElement | null;
  if (!el) throw new Error("ReactFlow viewport not found");
  return el;
}

function bgColor(): string {
  const root = document.querySelector(".react-flow") as HTMLElement | null;
  if (!root) return "#ffffff";
  const c = getComputedStyle(root).backgroundColor;
  return c && c !== "rgba(0, 0, 0, 0)" ? c : "#ffffff";
}

function makeTransform(rf: ReactFlowInstance): string {
  const bounds = getNodesBounds(rf.getNodes());
  const viewport = getViewportForBounds(
    bounds,
    EXPORT_WIDTH,
    EXPORT_HEIGHT,
    0.5,
    2,
    EXPORT_PADDING,
  );
  return `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`;
}

/**
 * Before rasterizing, walk every edge label and inline its background +
 * foreground colors. CSS variables like `--card` and `--foreground` aren't
 * resolved when `html-to-image` clones SVG/rect/text nodes, which produced
 * unreadable black-on-black labels in dark-mode exports. Returns a function
 * that restores the original inline styles when called.
 */
function inlineEdgeLabelColors(root: HTMLElement): () => void {
  const restorers: Array<() => void> = [];

  const card = getComputedStyle(document.body).getPropertyValue("--card").trim() || "#ffffff";
  const fg = getComputedStyle(document.body).getPropertyValue("--foreground").trim() || "#000000";

  const bgs = root.querySelectorAll<SVGRectElement>(".react-flow__edge-textbg");
  for (const el of Array.from(bgs)) {
    const prev = el.getAttribute("style") ?? "";
    el.setAttribute("style", `${prev};fill:${card};`);
    restorers.push(() => el.setAttribute("style", prev));
  }

  const texts = root.querySelectorAll<SVGTextElement>(".react-flow__edge-text");
  for (const el of Array.from(texts)) {
    const prev = el.getAttribute("style") ?? "";
    el.setAttribute("style", `${prev};fill:${fg};`);
    restorers.push(() => el.setAttribute("style", prev));
  }

  return () => {
    for (const r of restorers) r();
  };
}

async function rasterize(
  rf: ReactFlowInstance,
  format: "png" | "jpg",
): Promise<{ dataUrl: string }> {
  const el = findViewportEl();
  const bg = bgColor();
  const transform = makeTransform(rf);
  const restore = inlineEdgeLabelColors(el);
  try {
    const options = {
      backgroundColor: bg,
      width: EXPORT_WIDTH,
      height: EXPORT_HEIGHT,
      style: {
        width: `${EXPORT_WIDTH}px`,
        height: `${EXPORT_HEIGHT}px`,
        transform,
      },
    };
    const dataUrl =
      format === "png" ? await toPng(el, options) : await toJpeg(el, { ...options, quality: 0.95 });
    return { dataUrl };
  } finally {
    restore();
  }
}

export async function exportDocAsPng(
  rf: ReactFlowInstance,
  suggestedName: string,
): Promise<boolean> {
  const path = await ipc.pickSavePathWithFilter(`${stripExt(suggestedName)}.png`, "PNG", ["png"]);
  if (!path) return false;
  const { dataUrl } = await rasterize(rf, "png");
  const base64 = dataUrl.split(",")[1] ?? "";
  await ipc.writeBinaryFile(path, base64);
  return true;
}

export async function exportDocAsJpg(
  rf: ReactFlowInstance,
  suggestedName: string,
): Promise<boolean> {
  const path = await ipc.pickSavePathWithFilter(`${stripExt(suggestedName)}.jpg`, "JPEG", [
    "jpg",
    "jpeg",
  ]);
  if (!path) return false;
  const { dataUrl } = await rasterize(rf, "jpg");
  const base64 = dataUrl.split(",")[1] ?? "";
  await ipc.writeBinaryFile(path, base64);
  return true;
}
