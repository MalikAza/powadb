import type { Feature, FeatureCollection, GeoJsonObject, Geometry as GJGeometry } from "geojson";
import GeoJSONFormat from "ol/format/GeoJSON";
import type { Geometry } from "ol/geom";
import VectorLayer from "ol/layer/Vector";
import VectorSource from "ol/source/Vector";
import { useEffect, useMemo } from "react";
import { useMapContext } from "./map-context";
import { defaultFeatureStyle } from "./styles";

type Props = {
  name?: string;
  data: GeoJsonObject;
  fitOnMount?: boolean;
};

function wrapAsFeatureCollection(input: GeoJsonObject): FeatureCollection {
  if (input.type === "FeatureCollection") {
    return input as FeatureCollection;
  }
  if (input.type === "Feature") {
    return { type: "FeatureCollection", features: [input as Feature] };
  }
  // Bare geometry (what `ST_AsGeoJSON` returns) — wrap it.
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {},
        geometry: input as GJGeometry,
      },
    ],
  };
}

export function GeoJSONLayer({ name = "Geometry", data, fitOnMount = true }: Props) {
  const { map, registerLayer, unregisterLayer } = useMapContext();

  const layer = useMemo(() => {
    const fc = wrapAsFeatureCollection(data);
    const features = new GeoJSONFormat().readFeatures(fc, {
      dataProjection: "EPSG:4326",
      featureProjection: "EPSG:3857",
    });
    const source = new VectorSource({ features });
    const vl = new VectorLayer({
      source,
      style: defaultFeatureStyle,
      zIndex: 10,
    });
    vl.set("name", name);
    return vl;
  }, [data, name]);

  useEffect(() => {
    registerLayer(layer);
    return () => unregisterLayer(layer);
  }, [layer, registerLayer, unregisterLayer]);

  useEffect(() => {
    if (!fitOnMount) return;
    const source = layer.getSource();
    if (!source) return;
    const extent = source.getExtent();
    if (!extent || !Number.isFinite(extent[0])) return;
    const geometry = source.getFeatures()[0]?.getGeometry() as Geometry | undefined;
    const isPointLike = geometry && geometry.getType() === "Point";
    // biome-ignore lint/suspicious/noFocusedTests: ol View.fit() — not a test focus marker
    map.getView().fit(extent, {
      padding: [40, 40, 40, 40],
      maxZoom: isPointLike ? 14 : 20,
      duration: 350,
    });
  }, [layer, map, fitOnMount]);

  return null;
}
