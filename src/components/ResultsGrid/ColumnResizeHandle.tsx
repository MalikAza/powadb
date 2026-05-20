import { cn } from "@/lib/utils";

type Props = {
  onPointerDown: (e: React.PointerEvent) => void;
  onDoubleClick: () => void;
  className?: string;
};

export function ColumnResizeHandle({ onPointerDown, onDoubleClick, className }: Props) {
  return (
    <div
      onPointerDown={onPointerDown}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onDoubleClick();
      }}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      aria-hidden="true"
      className={cn(
        "absolute right-0 top-0 z-30 h-full w-[10px] cursor-col-resize touch-none select-none border-r border-border/40 transition-colors hover:border-primary active:border-primary",
        className,
      )}
    />
  );
}
