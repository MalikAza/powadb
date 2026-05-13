import type { GeoJsonObject } from "geojson";
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ipc } from "@/ipc";
import { GeoJSONLayer } from "./GeoJSONLayer";
import { LayerSidebar } from "./LayerSidebar";
import { MapRoot } from "./MapRoot";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connectionId: string;
  columnName: string;
  ewkbHex: string;
};

export function GeometryMapDialog({
  open,
  onOpenChange,
  connectionId,
  columnName,
  ewkbHex,
}: Props) {
  const [geojson, setGeojson] = useState<GeoJsonObject | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) {
      setGeojson(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    ipc
      .geometryToGeoJSON(connectionId, ewkbHex)
      .then((raw) => {
        if (cancelled) return;
        try {
          setGeojson(JSON.parse(raw) as GeoJsonObject);
        } catch (e) {
          setError(`Failed to parse GeoJSON: ${String(e)}`);
        }
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
  }, [open, connectionId, ewkbHex]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[80vh] w-[90vw] max-w-[90vw] flex-col gap-2 p-4 sm:max-w-[90vw]">
        <DialogHeader>
          <DialogTitle className="font-mono text-sm">{columnName}</DialogTitle>
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
          {geojson && (
            <MapRoot>
              <GeoJSONLayer name={columnName} data={geojson} fitOnMount />
              <LayerSidebar />
            </MapRoot>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
