import type MapBrowserEvent from "ol/MapBrowserEvent";
import { useEffect, useRef, useState } from "react";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { useMapContext } from "./map-context";

type Hit = {
  x: number;
  y: number;
  columnName: string;
  rowIndex: number;
  pkLabel: string | null;
};

/**
 * Listens for `singleclick` events on the OL map. If a feature is under the
 * pointer, anchors a shadcn Popover at the click point and shows the
 * feature's source column + row identifier.
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
          if (columnName === null || rowIndex === null) return false;
          const pkLabel = typeof props.pkLabel === "string" ? props.pkLabel : null;
          const orig = e.originalEvent as MouseEvent;
          found = {
            x: orig.clientX,
            y: orig.clientY,
            columnName,
            rowIndex,
            pkLabel,
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
        <PopoverContent side="top" sideOffset={8} className="w-auto min-w-48 max-w-xs p-3 text-xs">
          <div className="font-mono text-[11px] text-muted-foreground">{hit.columnName}</div>
          <div className="mt-0.5 font-medium">{hit.pkLabel ?? `Row #${hit.rowIndex + 1}`}</div>
        </PopoverContent>
      )}
    </Popover>
  );
}
