import type { Feature, GeoJsonObject, Geometry } from "geojson";
import { Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ipc } from "@/ipc";
import { FeatureClickPopup } from "./FeatureClickPopup";
import { GeoJSONLayer } from "./GeoJSONLayer";
import { LayerSidebar } from "./LayerSidebar";
import { MapRoot } from "./MapRoot";

export type GeometryMapInput =
  | { kind: "single"; columnName: string; ewkbHex: string }
  | {
      kind: "multi";
      title: string;
      columns: Array<{
        name: string;
        values: Array<{ rowIndex: number; pkLabel: string | null; ewkbHex: string }>;
      }>;
    };

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connectionId: string;
  input: GeometryMapInput;
};

type LoadedSingle = { kind: "single"; columnName: string; geometry: GeoJsonObject };
type LoadedMulti = {
  kind: "multi";
  columns: Array<{ name: string; features: Feature[] }>;
};
type Loaded = LoadedSingle | LoadedMulti;

export function GeometryMapDialog({ open, onOpenChange, connectionId, input }: Props) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const title = useMemo(() => {
    if (input.kind === "single") return input.columnName;
    const totalRows = input.columns.reduce((acc, c) => acc + c.values.length, 0);
    const colSuffix =
      input.columns.length === 1 ? input.columns[0].name : `${input.columns.length} columns`;
    return `${input.title} · ${colSuffix} · ${totalRows} feature${totalRows === 1 ? "" : "s"}`;
  }, [input]);

  useEffect(() => {
    if (!open) {
      setLoaded(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);

    if (input.kind === "single") {
      ipc
        .geometryToGeoJSON(connectionId, input.ewkbHex)
        .then((raw) => {
          if (cancelled) return;
          setLoaded({
            kind: "single",
            columnName: input.columnName,
            geometry: JSON.parse(raw) as GeoJsonObject,
          });
        })
        .catch((e) => {
          if (!cancelled) setError(String(e));
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
      return () => {
        cancelled = true;
      };
    }

    // multi: flatten all hex values into one IPC call, then split back per column.
    const flat: { columnIdx: number; entry: (typeof input.columns)[number]["values"][number] }[] =
      [];
    input.columns.forEach((c, columnIdx) => {
      for (const entry of c.values) flat.push({ columnIdx, entry });
    });

    if (flat.length === 0) {
      setLoaded({
        kind: "multi",
        columns: input.columns.map((c) => ({ name: c.name, features: [] })),
      });
      setLoading(false);
      return;
    }

    ipc
      .geometriesToGeoJSON(
        connectionId,
        flat.map((f) => f.entry.ewkbHex),
      )
      .then((rawList) => {
        if (cancelled) return;
        const perColumn: Array<{ name: string; features: Feature[] }> = input.columns.map((c) => ({
          name: c.name,
          features: [],
        }));
        flat.forEach((f, i) => {
          const raw = rawList[i];
          if (!raw) return;
          let geometry: Geometry;
          try {
            geometry = JSON.parse(raw) as Geometry;
          } catch {
            return;
          }
          perColumn[f.columnIdx].features.push({
            type: "Feature",
            properties: {
              rowIndex: f.entry.rowIndex,
              pkLabel: f.entry.pkLabel,
              columnName: input.columns[f.columnIdx].name,
            },
            geometry,
          });
        });
        setLoaded({ kind: "multi", columns: perColumn });
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, connectionId, input]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[80vh] w-[90vw] max-w-[90vw] flex-col gap-2 p-4 sm:max-w-[90vw]">
        <DialogHeader>
          <DialogTitle className="font-mono text-sm">{title}</DialogTitle>
        </DialogHeader>
        <div className="relative min-h-0 flex-1 overflow-hidden rounded-md border border-border">
          {loading && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/60">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          )}
          {error && (
            <div className="absolute inset-0 z-10 flex items-center justify-center p-4">
              <pre className="max-w-full overflow-auto rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
                {error}
              </pre>
            </div>
          )}
          {loaded && (
            <MapRoot>
              {loaded.kind === "single" ? (
                <GeoJSONLayer name={loaded.columnName} data={loaded.geometry} fitOnMount />
              ) : (
                loaded.columns.map((col, i) =>
                  col.features.length === 0 ? null : (
                    <GeoJSONLayer
                      key={col.name}
                      name={col.name}
                      features={col.features}
                      colorIndex={i}
                      fitOnMount={i === 0}
                    />
                  ),
                )
              )}
              <FeatureClickPopup />
              <LayerSidebar />
            </MapRoot>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
