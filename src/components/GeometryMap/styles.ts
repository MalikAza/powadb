import { Circle as CircleStyle, Fill, Stroke, Style } from "ol/style";

export const defaultFeatureStyle = new Style({
  stroke: new Stroke({ color: "#2563eb", width: 2 }),
  fill: new Fill({ color: "rgba(37, 99, 235, 0.18)" }),
  image: new CircleStyle({
    radius: 6,
    fill: new Fill({ color: "#2563eb" }),
    stroke: new Stroke({ color: "#ffffff", width: 1.5 }),
  }),
});
