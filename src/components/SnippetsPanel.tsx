import { RefreshCw, Save, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ByteaDisplayMode } from "@/lib/bytea";
import { ipc, type Snippet } from "../ipc";
import { useConnections } from "../stores/connections";
import { useTabs } from "../stores/tabs";
import { ConfirmDialog } from "./ConfirmDialog";

const VALID_MODES: ReadonlySet<ByteaDisplayMode> = new Set(["hex", "ulid", "uuid"]);

function parseByteaModesJson(raw: string | null): Record<string, ByteaDisplayMode> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, ByteaDisplayMode> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string" && VALID_MODES.has(v as ByteaDisplayMode)) {
        out[k] = v as ByteaDisplayMode;
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function SnippetsPanel() {
  const activeId = useConnections((s) => s.activeId);
  const tabs = useTabs((s) => s.tabs);
  const activeTabId = useTabs((s) => s.activeTabId);
  const newQueryTab = useTabs((s) => s.newQueryTab);
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [loading, setLoading] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Snippet | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [saveScope, setSaveScope] = useState<"connection" | "global">("connection");

  const activeTabRaw = tabs.find((t) => t.id === activeTabId);
  const activeTab = activeTabRaw?.kind === "query" ? activeTabRaw : null;

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setSnippets(await ipc.listSnippets(activeId ?? undefined));
    } finally {
      setLoading(false);
    }
  }, [activeId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function saveCurrent() {
    if (!activeTab || !saveName.trim()) return;
    const modes = activeTab.byteaModes;
    const hasModes = Object.keys(modes).length > 0;
    await ipc.saveSnippet({
      name: saveName.trim(),
      sql: activeTab.sql,
      connection_id: saveScope === "connection" ? activeId : null,
      bytea_modes_json: hasModes ? JSON.stringify(modes) : null,
    });
    setSaveName("");
    setSaveOpen(false);
    await refresh();
  }

  function openInNewTab(snippet: Snippet) {
    if (!activeId) return;
    newQueryTab(activeId, snippet.sql, snippet.name, {
      byteaModes: parseByteaModesJson(snippet.bytea_modes_json),
      snippetId: snippet.id,
    });
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
          const oneLine = s.sql.replace(/\s+/g, " ").trim();
          return (
            <div
              key={s.id}
              onDoubleClick={() => openInNewTab(s)}
              title="Double-click to open in a new query tab"
              className="cursor-pointer rounded border border-border/40 bg-card/50 p-2 hover:bg-sidebar-accent"
            >
              <div className="flex items-center justify-between gap-1">
                <span className="truncate font-medium">{s.name}</span>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-5"
                  onClick={(e) => {
                    e.stopPropagation();
                    setPendingDelete(s);
                  }}
                  title="Delete"
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

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        title={`Delete snippet "${pendingDelete?.name ?? ""}"?`}
        description="The snippet will be permanently removed."
        confirmLabel="Delete"
        onConfirm={() => {
          if (!pendingDelete) return;
          const id = pendingDelete.id;
          setPendingDelete(null);
          ipc.deleteSnippet(id).then(refresh);
        }}
      />
    </div>
  );
}
