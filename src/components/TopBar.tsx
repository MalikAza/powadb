import { useConnections } from "../stores/connections";

const isMacTauri =
  typeof window !== "undefined" &&
  "__TAURI_INTERNALS__" in window &&
  navigator.userAgent.includes("Mac");

export function TopBar() {
  const { connections, activeId } = useConnections();
  const conn = connections.find((c) => c.id === activeId);

  return (
    <div
      data-tauri-drag-region
      className="flex py-1 items-center justify-between border-b border-border bg-sidebar px-6 text-xs"
      style={isMacTauri ? { paddingLeft: 78 } : undefined}
    >
      <div className="flex items-center gap-2 font-semibold">
        <img
          src="/powadb-logo.png"
          alt="PowaDB"
          className="size-7"
          style={{ pointerEvents: "none" }}
        />
        <span>PowaDB</span>
        {conn && (
          <span className="ml-3 flex items-center gap-2 font-normal text-muted-foreground">
            {conn.color && (
              <span
                aria-hidden
                className="inline-block size-2.5 rounded-full"
                style={{ backgroundColor: conn.color }}
              />
            )}
            <span className="text-foreground">{conn.name}</span>
            <span className="opacity-60">
              {conn.kind} · {conn.host}:{conn.port}/{conn.database}
            </span>
          </span>
        )}
      </div>
      <div className="text-muted-foreground">
        <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px]">
          ⌘K
        </kbd>
        <span className="ml-1.5">commands</span>
      </div>
    </div>
  );
}
