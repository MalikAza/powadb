import Point from "ol/geom/Point";
import type MapBrowserEvent from "ol/MapBrowserEvent";
import { toLonLat } from "ol/proj";
import { useEffect, useRef, useState } from "react";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { useMapContext } from "./map-context";

type RowDataEntry = [columnName: string, value: unknown];

type Hit = {
  x: number;
  y: number;
  /** Source column name; null in single-geometry mode where it isn't attached. */
  columnName: string | null;
  /** Row index; null in single-geometry mode. */
  rowIndex: number | null;
  pkLabel: string | null;
  /** Other (non-geometry) columns from the source row, in query order. */
  rowData: RowDataEntry[] | null;
  /** [lon, lat] in EPSG:4326. Set only for Point geometries. */
  lonLat: [number, number] | null;
};

function formatPopupValue(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "object") {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

function isRowDataArray(v: unknown): v is RowDataEntry[] {
  return (
    Array.isArray(v) &&
    v.every((e) => Array.isArray(e) && e.length === 2 && typeof e[0] === "string")
  );
}

/**
 * Listens for `singleclick` events on the OL map. If a feature is under the
 * pointer, anchors a shadcn Popover at the click point and shows the
 * feature's source column, row identifier, row data, and (for points)
 * lat/lng.
 */
export function FeatureClickPopup() {
  const { map } = useMapContext();
  const [hit, setHit] = useState<Hit | null>(null);
  const anchorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClick = (e: MapBrowserEvent<PointerEvent>) => {
      let found: Hit | null = null;
      map.forEachFeatureAtPixel(
        e.pixel,
        (feature) => {
          const props = feature.getProperties() as Record<string, unknown>;
          const columnName = typeof props.columnName === "string" ? props.columnName : null;
          const rowIndex = typeof props.rowIndex === "number" ? props.rowIndex : null;
          const pkLabel = typeof props.pkLabel === "string" ? props.pkLabel : null;
          const rowData = isRowDataArray(props.rowData) ? props.rowData : null;
          const geom = feature.getGeometry();
          let lonLat: [number, number] | null = null;
          if (geom instanceof Point) {
            const [lon, lat] = toLonLat(geom.getCoordinates());
            lonLat = [lon, lat];
          }
          // Skip features that would render an empty popup.
          if (columnName === null && rowData === null && lonLat === null) return false;
          const orig = e.originalEvent as MouseEvent;
          found = {
            x: orig.clientX,
            y: orig.clientY,
            columnName,
            rowIndex,
            pkLabel,
            rowData,
            lonLat,
          };
          return true;
        },
        { hitTolerance: 4 },
      );
      setHit(found);
    };
    // Cast required: OL's per-event listener typings are stricter than the
    // generic Map.on() overload TypeScript picks up for a string literal.
    const handler = onClick as unknown as Parameters<typeof map.on>[1];
    map.on("singleclick", handler);
    return () => {
      map.un("singleclick", handler);
    };
  }, [map]);

  const hasHeader = hit !== null && (hit.columnName !== null || hit.rowIndex !== null);
  const hasRowData = hit?.rowData !== null && hit?.rowData !== undefined && hit.rowData.length > 0;
  const hasLonLat = hit?.lonLat !== null && hit?.lonLat !== undefined;

  return (
    <Popover open={hit !== null} onOpenChange={(o) => !o && setHit(null)}>
      <PopoverAnchor asChild>
        <div
          ref={anchorRef}
          aria-hidden
          className="pointer-events-none fixed"
          style={{
            left: hit?.x ?? 0,
            top: hit?.y ?? 0,
            width: 0,
            height: 0,
          }}
        />
      </PopoverAnchor>
      {hit && (
        <PopoverContent side="top" sideOffset={8} className="w-auto min-w-48 max-w-sm p-3 text-xs">
          {hit.columnName && (
            <div className="font-mono text-[11px] text-muted-foreground">{hit.columnName}</div>
          )}
          {hit.rowIndex !== null && (
            <div className="mt-0.5 font-medium">{hit.pkLabel ?? `Row #${hit.rowIndex + 1}`}</div>
          )}
          {hasRowData && (
            <div
              className={`space-y-0.5 font-mono text-[11px] ${
                hasHeader ? "mt-1.5 border-t border-border pt-1.5" : ""
              }`}
            >
              {hit.rowData?.map(([name, value]) => (
                <div key={name} className="flex gap-2">
                  <span className="shrink-0 text-muted-foreground/70">{name}</span>
                  <span className="min-w-0 flex-1 truncate" title={formatPopupValue(value)}>
                    {formatPopupValue(value)}
                  </span>
                </div>
              ))}
            </div>
          )}
          {hasLonLat && hit.lonLat && (
            <div
              className={`font-mono text-[11px] text-muted-foreground ${
                hasHeader || hasRowData ? "mt-1.5 border-t border-border pt-1.5" : ""
              }`}
            >
              <div>
                <span className="text-muted-foreground/70">lat </span>
                {hit.lonLat[1].toFixed(6)}
              </div>
              <div>
                <span className="text-muted-foreground/70">lng </span>
                {hit.lonLat[0].toFixed(6)}
              </div>
            </div>
          )}
        </PopoverContent>
      )}
    </Popover>
  );
}
