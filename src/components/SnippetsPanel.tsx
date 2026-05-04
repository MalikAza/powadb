import { RefreshCw, Save, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ipc, type Snippet } from "../ipc";
import { useConnections } from "../stores/connections";
import { useTabs } from "../stores/tabs";

export function SnippetsPanel() {
  const { activeId } = useConnections();
  const { tabs, activeTabId, patchTab } = useTabs();
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [loading, setLoading] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [saveScope, setSaveScope] = useState<"connection" | "global">("connection");

  const activeTabRaw = tabs.find((t) => t.id === activeTabId);
  const activeTab = activeTabRaw?.kind === "query" ? activeTabRaw : null;

  async function refresh() {
    setLoading(true);
    try {
      setSnippets(await ipc.listSnippets(activeId ?? undefined));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, [activeId]);

  useEffect(() => {
    if (!confirmDeleteId) return;
    const t = setTimeout(() => setConfirmDeleteId(null), 3000);
    return () => clearTimeout(t);
  }, [confirmDeleteId]);

  async function saveCurrent() {
    if (!activeTab || !saveName.trim()) return;
    await ipc.saveSnippet({
      name: saveName.trim(),
      sql: activeTab.sql,
      connection_id: saveScope === "connection" ? activeId : null,
    });
    setSaveName("");
    setSaveOpen(false);
    await refresh();
  }

  function loadIntoTab(sql: string) {
    if (!activeTab) return;
    patchTab(activeTab.id, { sql } as Partial<typeof activeTab>);
  }

  return (
    <div className="text-xs">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Snippets
        </span>
        <div className="flex gap-1">
          <Button
            size="icon"
            variant="ghost"
            className="size-6"
            onClick={() => setSaveOpen((v) => !v)}
            disabled={!activeTab}
            title="Save current tab as snippet"
          >
            <Save className="size-3" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="size-6"
            onClick={refresh}
            disabled={loading}
          >
            <RefreshCw className={loading ? "size-3 animate-spin" : "size-3"} />
          </Button>
        </div>
      </div>

      {saveOpen && activeTab && (
        <div className="mb-2 grid gap-2 rounded border border-border bg-card p-2">
          <Input
            autoFocus
            placeholder="Snippet name"
            value={saveName}
            onChange={(e) => setSaveName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") saveCurrent();
              if (e.key === "Escape") setSaveOpen(false);
            }}
            className="h-7 text-xs"
          />
          <div className="flex items-center gap-3 text-[11px]">
            <Label className="flex cursor-pointer items-center gap-1 font-normal">
              <input
                type="radio"
                checked={saveScope === "connection"}
                onChange={() => setSaveScope("connection")}
                disabled={!activeId}
              />
              this connection
            </Label>
            <Label className="flex cursor-pointer items-center gap-1 font-normal">
              <input
                type="radio"
                checked={saveScope === "global"}
                onChange={() => setSaveScope("global")}
              />
              global
            </Label>
          </div>
          <div className="flex justify-end gap-1">
            <Button
              size="sm"
              variant="ghost"
              className="h-6 text-xs"
              onClick={() => setSaveOpen(false)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              className="h-6 text-xs"
              onClick={saveCurrent}
              disabled={!saveName.trim()}
            >
              Save
            </Button>
          </div>
        </div>
      )}

      {snippets.length === 0 && !loading && (
        <p className="text-muted-foreground">No snippets yet.</p>
      )}
      <div className="flex flex-col gap-1">
        {snippets.map((s) => {
          const armed = confirmDeleteId === s.id;
          const oneLine = s.sql.replace(/\s+/g, " ").trim();
          return (
            <div
              key={s.id}
              onDoubleClick={() => loadIntoTab(s.sql)}
              title="Double-click to load into the active tab"
              className="cursor-pointer rounded border border-border/40 bg-card/50 p-2 hover:bg-sidebar-accent"
            >
              <div className="flex items-center justify-between gap-1">
                <span className="truncate font-medium">{s.name}</span>
                <Button
                  size="icon"
                  variant={armed ? "destructive" : "ghost"}
                  className="size-5"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (armed) {
                      ipc.deleteSnippet(s.id).then(refresh);
                      setConfirmDeleteId(null);
                    } else {
                      setConfirmDeleteId(s.id);
                    }
                  }}
                  title={armed ? "Click again to confirm" : "Delete"}
                >
                  <X className="size-3" />
                </Button>
              </div>
              <div className="truncate font-mono text-[11px] text-muted-foreground">{oneLine}</div>
              {!s.connection_id && (
                <div className="mt-0.5 text-[9px] text-muted-foreground">global</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
