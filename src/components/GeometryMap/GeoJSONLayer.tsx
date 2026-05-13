import type { Feature, FeatureCollection, GeoJsonObject, Geometry as GJGeometry } from "geojson";
import GeoJSONFormat from "ol/format/GeoJSON";
import type { Geometry } from "ol/geom";
import VectorLayer from "ol/layer/Vector";
import VectorSource from "ol/source/Vector";
import { useEffect, useMemo } from "react";
import { useMapContext } from "./map-context";
import { styleForColor } from "./styles";

type CommonProps = {
  name?: string;
  fitOnMount?: boolean;
  colorIndex?: number;
};

type SingleProps = CommonProps & {
  data: GeoJsonObject;
  features?: undefined;
};

type FeaturesProps = CommonProps & {
  data?: undefined;
  /**
   * Pre-built GeoJSON features with arbitrary `properties`. Each feature's
   * properties are preserved on the resulting OL Feature so a click handler
   * can read them back (e.g. row index, PK, source column).
   */
  features: Feature[];
};

type Props = SingleProps | FeaturesProps;

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

export function GeoJSONLayer(props: Props) {
  const { name = "Geometry", fitOnMount = true, colorIndex = 0 } = props;
  const { map, registerLayer, unregisterLayer } = useMapContext();

  const layer = useMemo(() => {
    const fc: FeatureCollection =
      "features" in props && props.features
        ? { type: "FeatureCollection", features: props.features }
        : wrapAsFeatureCollection(props.data as GeoJsonObject);
    const features = new GeoJSONFormat().readFeatures(fc, {
      dataProjection: "EPSG:4326",
      featureProjection: "EPSG:3857",
    });
    const source = new VectorSource({ features });
    const vl = new VectorLayer({
      source,
      style: styleForColor(colorIndex),
      zIndex: 10,
    });
    vl.set("name", name);
    return vl;
  }, [name, colorIndex, "features" in props ? props.features : props.data]);

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
    const features = source.getFeatures();
    const allPoints =
      features.length > 0 &&
      features.every((f) => (f.getGeometry() as Geometry | undefined)?.getType() === "Point");
    // biome-ignore lint/suspicious/noFocusedTests: ol View.fit() — not a test focus marker
    map.getView().fit(extent, {
      padding: [40, 40, 40, 40],
      maxZoom: allPoints ? 14 : 20,
      duration: 350,
    });
  }, [layer, map, fitOnMount]);

  return null;
}
