import { ChevronDown, Eye, EyeOff } from "lucide-react";
import type BaseLayer from "ol/layer/Base";
import VectorLayer from "ol/layer/Vector";
import { useCallback, useState, useSyncExternalStore } from "react";
import { cn } from "@/lib/utils";
import { useMapContext } from "./map-context";

function getLayerName(layer: BaseLayer): string {
  return (layer.get("name") as string | undefined) ?? "Layer";
}

function getFeatureCount(layer: BaseLayer): number | null {
  if (!(layer instanceof VectorLayer)) return null;
  const src = layer.getSource();
  if (!src) return null;
  // VectorSource has getFeatures(); other Source types we don't expect here.
  const getFeatures = (src as { getFeatures?: () => unknown[] }).getFeatures;
  if (typeof getFeatures !== "function") return null;
  return getFeatures.call(src).length;
}

export function LayerSidebar() {
  const { baseLayers, vectorLayers } = useMapContext();
  return (
    <div className="flex flex-col gap-4 p-3">
      <LayerGroup title="Geometry" layers={vectorLayers} defaultOpen emptyLabel="No layers" />
      <LayerGroup title="Base maps" layers={baseLayers} defaultOpen={false} />
    </div>
  );
}

function LayerGroup({
  title,
  layers,
  defaultOpen,
  emptyLabel,
}: {
  title: string;
  layers: BaseLayer[];
  defaultOpen: boolean;
  emptyLabel?: string;
}) {
  // Initial value only — the user toggles `open` after mount, so we cannot
  // derive from `defaultOpen` during render.
  const [open, setOpen] = useState(() => defaultOpen);

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between text-xs font-medium uppercase tracking-wide text-muted-foreground hover:text-foreground"
      >
        <span>{title}</span>
        <ChevronDown className={cn("size-3.5 transition-transform", !open && "-rotate-90")} />
      </button>
      {open && (
        <div className="mt-2 flex flex-col gap-2">
          {layers.length === 0 ? (
            emptyLabel ? (
              <div className="text-xs text-muted-foreground">{emptyLabel}</div>
            ) : null
          ) : (
            layers.map((layer) => <LayerControl key={getLayerName(layer)} layer={layer} />)
          )}
        </div>
      )}
    </div>
  );
}

function LayerControl({ layer }: { layer: BaseLayer }) {
  const subscribeVisible = useCallback(
    (cb: () => void) => {
      layer.on("change:visible", cb);
      return () => layer.un("change:visible", cb);
    },
    [layer],
  );
  const subscribeOpacity = useCallback(
    (cb: () => void) => {
      layer.on("change:opacity", cb);
      return () => layer.un("change:opacity", cb);
    },
    [layer],
  );
  const visible = useSyncExternalStore(subscribeVisible, () => layer.getVisible());
  const opacityRaw = useSyncExternalStore(subscribeOpacity, () => layer.getOpacity());
  const opacity = Math.round(opacityRaw * 100);
  const [expanded, setExpanded] = useState(false);

  const toggleVisible = (e: React.MouseEvent) => {
    e.stopPropagation();
    layer.setVisible(!visible);
  };

  const onOpacityChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    layer.setOpacity(Number(e.target.value) / 100);
  };

  return (
    <div className="rounded-md border border-border bg-card">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between gap-2 p-2 text-left"
      >
        <span
          className={cn(
            "truncate text-xs font-medium",
            !visible && "text-muted-foreground line-through",
          )}
        >
          {getLayerName(layer)}
          {(() => {
            const n = getFeatureCount(layer);
            return n !== null && n > 1 ? (
              <span className="ml-1 font-mono text-[10px] text-muted-foreground">({n})</span>
            ) : null;
          })()}
        </span>
        <span className="flex items-center gap-1">
          <span
            role="button"
            tabIndex={0}
            onClick={toggleVisible}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ")
                toggleVisible(e as unknown as React.MouseEvent);
            }}
            className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            aria-label={visible ? "Hide layer" : "Show layer"}
          >
            {visible ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
          </span>
          <ChevronDown
            className={cn(
              "size-3.5 text-muted-foreground transition-transform",
              !expanded && "-rotate-90",
            )}
          />
        </span>
      </button>
      {expanded && (
        <div className="border-t border-border p-2">
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-muted-foreground">Opacity</span>
            <input
              type="range"
              min={0}
              max={100}
              value={opacity}
              onChange={onOpacityChange}
              disabled={!visible}
              className="h-1 flex-1 accent-primary"
            />
            <span className="w-9 text-right font-mono text-[10px] text-muted-foreground">
              {opacity}%
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
