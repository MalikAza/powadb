import { cn } from "@/lib/utils";

type Props = {
  onPointerDown: (e: React.PointerEvent) => void;
  onDoubleClick: () => void;
  className?: string;
};

/**
 * Drag handle pinned to the right edge of a header cell. The handle stops
 * pointer/click propagation so the underlying header (sort, column-select)
 * doesn't fire while the user is resizing.
 *
 * Inline styles deliberately set the critical positioning + cursor properties
 * so the handle works even if Tailwind utility classes get stripped or
 * overridden — discoverability is more important than DRY here.
 */
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
      style={{
        position: "absolute",
        right: 0,
        top: 0,
        height: "100%",
        width: 10,
        cursor: "col-resize",
        touchAction: "none",
        userSelect: "none",
        zIndex: 30,
      }}
      className={cn(
        "border-r border-border/40 transition-colors hover:border-primary active:border-primary",
        className,
      )}
    />
  );
}
