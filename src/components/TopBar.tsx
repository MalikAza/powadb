import { Database } from "lucide-react";
import { useConnections } from "../stores/connections";

export function TopBar() {
  const { connections, activeId } = useConnections();
  const conn = connections.find((c) => c.id === activeId);

  return (
    <div className="flex h-10 items-center justify-between border-b border-border bg-sidebar px-3 text-xs">
      <div className="flex items-center gap-2 font-semibold">
        <Database className="size-4 text-primary" />
        <span>PowaDB</span>
        {conn && (
          <span className="ml-3 font-normal text-muted-foreground">
            <span className="text-foreground">{conn.name}</span>
            <span className="ml-2 opacity-60">
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
