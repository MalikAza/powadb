import type BaseLayer from "ol/layer/Base";
import type Layer from "ol/layer/Layer";
import type OLMap from "ol/Map";
import { createContext, useContext } from "react";

export type MapContextValue = {
  map: OLMap;
  registerLayer: (layer: Layer) => void;
  unregisterLayer: (layer: Layer) => void;
  baseLayers: BaseLayer[];
  vectorLayers: Layer[];
};

export const MapContext = createContext<MapContextValue | null>(null);

export function useMapContext(): MapContextValue {
  const ctx = useContext(MapContext);
  if (!ctx) {
    throw new Error("GeometryMap components must be used inside <MapRoot>");
  }
  return ctx;
}
