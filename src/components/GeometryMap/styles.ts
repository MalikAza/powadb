import { Circle as CircleStyle, Fill, Stroke, Style } from "ol/style";

type ColorPair = { stroke: string; fill: string };

// Six visually distinct hues. Cycled per-column when plotting multiple
// geometry columns on the same map, so users can read off which column a
// feature belongs to at a glance.
const PALETTE: ColorPair[] = [
  { stroke: "#2563eb", fill: "rgba(37, 99, 235, 0.18)" }, // blue
  { stroke: "#dc2626", fill: "rgba(220, 38, 38, 0.18)" }, // red
  { stroke: "#16a34a", fill: "rgba(22, 163, 74, 0.18)" }, // green
  { stroke: "#ea580c", fill: "rgba(234, 88, 12, 0.18)" }, // orange
  { stroke: "#9333ea", fill: "rgba(147, 51, 234, 0.18)" }, // purple
  { stroke: "#0891b2", fill: "rgba(8, 145, 178, 0.18)" }, // teal
];

export function colorForIndex(idx: number): ColorPair {
  return PALETTE[((idx % PALETTE.length) + PALETTE.length) % PALETTE.length];
}

export function styleForColor(idx: number): Style {
  const { stroke, fill } = colorForIndex(idx);
  return new Style({
    stroke: new Stroke({ color: stroke, width: 2 }),
    fill: new Fill({ color: fill }),
    image: new CircleStyle({
      radius: 6,
      fill: new Fill({ color: stroke }),
      stroke: new Stroke({ color: "#ffffff", width: 1.5 }),
    }),
  });
}

// Default style used by single-feature (v1) callers — same as palette index 0.
export const defaultFeatureStyle = styleForColor(0);
