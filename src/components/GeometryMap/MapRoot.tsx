import "ol/ol.css";
import type BaseLayer from "ol/layer/Base";
import type Layer from "ol/layer/Layer";
import TileLayer from "ol/layer/Tile";
import OLMap from "ol/Map";
import { fromLonLat } from "ol/proj";
import OSM from "ol/source/OSM";
import XYZ from "ol/source/XYZ";
import View from "ol/View";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MapContext, type MapContextValue } from "./map-context";

type Props = {
  children: ReactNode;
};

function makeBaseLayers(): TileLayer[] {
  // OSM: free worldwide raster tiles, visible by default.
  const osm = new TileLayer({ source: new OSM(), zIndex: 0 });
  osm.set("name", "OpenStreetMap");

  // IGN "Plan v2" raster tiles via the public WMTS endpoint at
  // https://data.geopf.fr/. No API key required. Hidden by default — user
  // can stack/blend it on top via the sidebar.
  const ign = new TileLayer({
    source: new XYZ({
      url: "https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2&STYLE=normal&FORMAT=image/png&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}",
      attributions: 'Carte © <a href="https://www.ign.fr/">IGN</a>',
      crossOrigin: "anonymous",
      maxZoom: 19,
    }),
    visible: false,
    zIndex: 1,
  });
  ign.set("name", "IGN Plan v2");

  return [osm, ign];
}

export function MapRoot({ children }: Props) {
  const mapRef = useRef<OLMap | null>(null);
  const baseLayersRef = useRef<TileLayer[] | null>(null);
  const [vectorLayers, setVectorLayers] = useState<Layer[]>([]);

  if (mapRef.current === null) {
    const baseLayers = makeBaseLayers();
    baseLayersRef.current = baseLayers;
    const map = new OLMap({
      layers: baseLayers,
      view: new View({ center: fromLonLat([2.2137, 46.2276]), zoom: 5 }),
      controls: [],
    });
    mapRef.current = map;
  }

  const mapCallbackRef = useCallback((node: HTMLDivElement | null) => {
    if (node && mapRef.current) {
      mapRef.current.setTarget(node);
      mapRef.current.updateSize();
      return () => {
        mapRef.current?.setTarget(undefined);
      };
    }
  }, []);

  const registerLayer = useCallback((layer: Layer) => {
    if (!mapRef.current) return;
    mapRef.current.addLayer(layer);
    setVectorLayers((prev) => (prev.includes(layer) ? prev : [...prev, layer]));
  }, []);

  const unregisterLayer = useCallback((layer: Layer) => {
    if (!mapRef.current) return;
    mapRef.current.removeLayer(layer);
    setVectorLayers((prev) => prev.filter((l) => l !== layer));
  }, []);

  const ctx: MapContextValue = useMemo(
    () => ({
      map: mapRef.current!,
      registerLayer,
      unregisterLayer,
      baseLayers: (baseLayersRef.current ?? []) as BaseLayer[],
      vectorLayers,
    }),
    [registerLayer, unregisterLayer, vectorLayers],
  );

  // OL needs an explicit updateSize() whenever the container dimensions
  // change. Tauri dialogs mount the map at zero size until layout settles.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const ro = new ResizeObserver(() => map.updateSize());
    const el = map.getTargetElement();
    if (el) ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <MapContext.Provider value={ctx}>
      <div className="relative flex h-full min-h-0 w-full overflow-hidden">
        <div ref={mapCallbackRef} className="h-full min-h-0 flex-1 bg-muted" />
        <div className="h-full w-64 shrink-0 overflow-y-auto border-l border-border bg-background">
          {children}
        </div>
      </div>
    </MapContext.Provider>
  );
}
