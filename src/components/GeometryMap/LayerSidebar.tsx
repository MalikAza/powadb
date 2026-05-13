import { ChevronDown, Eye, EyeOff } from "lucide-react";
import type BaseLayer from "ol/layer/Base";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { useMapContext } from "./map-context";

function getLayerName(layer: BaseLayer): string {
  return (layer.get("name") as string | undefined) ?? "Layer";
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
  const [open, setOpen] = useState(defaultOpen);

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
            layers.map((layer, i) => (
              <LayerControl key={`${getLayerName(layer)}-${i}`} layer={layer} />
            ))
          )}
        </div>
      )}
    </div>
  );
}

function LayerControl({ layer }: { layer: BaseLayer }) {
  const [visible, setVisible] = useState(layer.getVisible());
  const [opacity, setOpacity] = useState(Math.round(layer.getOpacity() * 100));
  const [expanded, setExpanded] = useState(false);

  // Keep local state in sync if the layer mutates externally.
  useEffect(() => {
    const onVis = () => setVisible(layer.getVisible());
    const onOpa = () => setOpacity(Math.round(layer.getOpacity() * 100));
    layer.on("change:visible", onVis);
    layer.on("change:opacity", onOpa);
    return () => {
      layer.un("change:visible", onVis);
      layer.un("change:opacity", onOpa);
    };
  }, [layer]);

  const toggleVisible = (e: React.MouseEvent) => {
    e.stopPropagation();
    const next = !visible;
    layer.setVisible(next);
    setVisible(next);
  };

  const onOpacityChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const pct = Number(e.target.value);
    layer.setOpacity(pct / 100);
    setOpacity(pct);
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
        <div className="border-t border-border px-2 py-2">
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
