import type { Feature, FeatureCollection, GeoJsonObject, Geometry } from "geojson";
import { Loader2 } from "lucide-react";
import { useEffect, useMemo, useReducer } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ipc } from "@/ipc";
import { FeatureClickPopup } from "./FeatureClickPopup";
import { GeoJSONLayer } from "./GeoJSONLayer";
import { LayerSidebar } from "./LayerSidebar";
import { MapRoot } from "./MapRoot";

/** Non-geometry columns from the source row, in query order. */
export type RowDataEntries = Array<[columnName: string, value: unknown]>;

export type GeometryMapInput =
  | {
      kind: "single";
      columnName: string;
      ewkbHex: string;
      rowData?: RowDataEntries;
    }
  | {
      kind: "multi";
      title: string;
      columns: Array<{
        name: string;
        values: Array<{
          rowIndex: number;
          pkLabel: string | null;
          ewkbHex: string;
          rowData?: RowDataEntries;
        }>;
      }>;
    };

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connectionId: string;
  input: GeometryMapInput;
};

type LoadedSingle = {
  kind: "single";
  columnName: string;
  features: Feature[];
};
type LoadedMulti = {
  kind: "multi";
  columns: Array<{ name: string; features: Feature[] }>;
};
type Loaded = LoadedSingle | LoadedMulti;

/**
 * Normalize whatever GeoJSON shape the backend returned into a Feature list,
 * folding `properties` into each feature (existing per-feature properties take
 * precedence so we don't clobber backend-attached metadata).
 */
function toFeatures(input: GeoJsonObject, properties: Record<string, unknown>): Feature[] {
  if (input.type === "FeatureCollection") {
    const fc = input as FeatureCollection;
    return fc.features.map((f) => ({
      ...f,
      properties: { ...properties, ...(f.properties ?? {}) },
    }));
  }
  if (input.type === "Feature") {
    const f = input as Feature;
    return [{ ...f, properties: { ...properties, ...(f.properties ?? {}) } }];
  }
  return [{ type: "Feature", properties, geometry: input as Geometry }];
}

type LoadState =
  | { status: "idle"; loaded: null; error: null }
  | { status: "loading"; loaded: null; error: null }
  | { status: "ready"; loaded: Loaded; error: null }
  | { status: "error"; loaded: null; error: string };
type LoadAction =
  | { type: "reset" }
  | { type: "load" }
  | { type: "ready"; loaded: Loaded }
  | { type: "fail"; error: string };
function loadReducer(_s: LoadState, a: LoadAction): LoadState {
  switch (a.type) {
    case "reset":
      return { status: "idle", loaded: null, error: null };
    case "load":
      return { status: "loading", loaded: null, error: null };
    case "ready":
      return { status: "ready", loaded: a.loaded, error: null };
    case "fail":
      return { status: "error", loaded: null, error: a.error };
  }
}

export function GeometryMapDialog({ open, onOpenChange, connectionId, input }: Props) {
  const [state, dispatch] = useReducer(loadReducer, {
    status: "idle",
    loaded: null,
    error: null,
  });
  const { loaded, error } = state;
  const loading = state.status === "loading";

  const title = useMemo(() => {
    if (input.kind === "single") return input.columnName;
    const totalRows = input.columns.reduce((acc, c) => acc + c.values.length, 0);
    const colSuffix =
      input.columns.length === 1 ? input.columns[0].name : `${input.columns.length} columns`;
    return `${input.title} · ${colSuffix} · ${totalRows} feature${totalRows === 1 ? "" : "s"}`;
  }, [input]);

  useEffect(() => {
    if (!open) {
      dispatch({ type: "reset" });
      return;
    }
    let cancelled = false;
    dispatch({ type: "load" });

    if (input.kind === "single") {
      ipc
        .geometryToGeoJSON(connectionId, input.ewkbHex)
        .then((raw) => {
          if (cancelled) return;
          const geometry = JSON.parse(raw) as GeoJsonObject;
          const features = toFeatures(geometry, {
            columnName: input.columnName,
            rowData: input.rowData ?? null,
          });
          dispatch({
            type: "ready",
            loaded: { kind: "single", columnName: input.columnName, features },
          });
        })
        .catch((e) => {
          if (!cancelled) dispatch({ type: "fail", error: String(e) });
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
      dispatch({
        type: "ready",
        loaded: {
          kind: "multi",
          columns: input.columns.map((c) => ({ name: c.name, features: [] })),
        },
      });
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
              rowData: f.entry.rowData ?? null,
            },
            geometry,
          });
        });
        dispatch({ type: "ready", loaded: { kind: "multi", columns: perColumn } });
      })
      .catch((e) => {
        if (!cancelled) dispatch({ type: "fail", error: String(e) });
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
                <GeoJSONLayer name={loaded.columnName} features={loaded.features} fitOnMount />
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
