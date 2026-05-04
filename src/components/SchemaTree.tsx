import {
  ChevronDown,
  ChevronRight,
  Eye,
  RefreshCw,
  Search,
  Table2,
  TableProperties,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ipc, type SchemaMeta } from "../ipc";
import { useConnections } from "../stores/connections";
import { useSchema } from "../stores/schema";
import { useTabs } from "../stores/tabs";
import { useUi } from "../stores/ui";

export function SchemaTree() {
  const { activeId, connections } = useConnections();
  const conn = connections.find((c) => c.id === activeId);
  const openBrowseTab = useTabs((s) => s.openBrowseTab);
  const setSchemaInStore = useSchema((s) => s.set);
  const openSchemas = useUi((s) => s.openSchemas);
  const openTables = useUi((s) => s.openTables);
  const toggleSchema = useUi((s) => s.toggleSchema);
  const toggleTable = useUi((s) => s.toggleTable);
  const setSchemaOpen = useUi((s) => s.setSchemaOpen);

  const [schemas, setSchemas] = useState<SchemaMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");

  async function refresh() {
    if (!activeId) return;
    setLoading(true);
    setError(null);
    try {
      const result = await ipc.introspectSchema(activeId);
      setSchemas(result);
      setSchemaInStore(activeId, result);
      if (conn?.kind === "postgres") setSchemaOpen("public", true);
      else if (result[0]) setSchemaOpen(result[0].name, true);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setSchemas(null);
    setError(null);
    setSearch("");
    if (activeId) refresh();
  }, [activeId]);

  function browseTable(schema: string, table: string) {
    if (!activeId) return;
    openBrowseTab(activeId, schema, table);
  }

  // Filter schemas/tables by search query
  const filteredSchemas = useMemo(() => {
    if (!schemas) return null;
    const q = search.trim().toLowerCase();
    if (!q) return schemas;
    return schemas
      .map((s) => ({
        ...s,
        tables: s.tables.filter(
          (t) => t.name.toLowerCase().includes(q) || s.name.toLowerCase().includes(q),
        ),
      }))
      .filter((s) => s.tables.length > 0);
  }, [schemas, search]);

  // When searching, treat all matching schemas as open
  const effectiveOpenSchemas = useMemo(() => {
    if (!search.trim() || !filteredSchemas) return openSchemas;
    const out = { ...openSchemas };
    for (const s of filteredSchemas) out[s.name] = true;
    return out;
  }, [openSchemas, search, filteredSchemas]);

  // Scroll an externally-revealed table into view
  const lastOpenTableKey = useRef<string | null>(null);
  useEffect(() => {
    const openedKeys = Object.entries(openTables)
      .filter(([, v]) => v)
      .map(([k]) => k);
    const newest = openedKeys[openedKeys.length - 1] ?? null;
    if (newest && newest !== lastOpenTableKey.current) {
      const el = document.querySelector(`[data-table-row="${cssEscape(newest)}"]`);
      el?.scrollIntoView({ block: "nearest" });
      lastOpenTableKey.current = newest;
    }
  }, [openTables]);

  if (!activeId) return null;

  return (
    <div className="text-xs">
      <div className="mb-2 flex items-center justify-between gap-1">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Schema
        </span>
        <Button size="icon" variant="ghost" className="size-6" onClick={refresh} disabled={loading}>
          <RefreshCw className={loading ? "size-3 animate-spin" : "size-3"} />
        </Button>
      </div>

      <div className="relative mb-2">
        <Search className="absolute left-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search tables…"
          className="h-7 pl-7 pr-7 text-[11px]"
        />
        {search && (
          <button
            type="button"
            onClick={() => setSearch("")}
            className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="size-3" />
          </button>
        )}
      </div>

      {error && <p className="whitespace-pre-wrap text-destructive">{error}</p>}
      {filteredSchemas?.length === 0 && search && (
        <p className="text-muted-foreground">No tables match.</p>
      )}

      {filteredSchemas?.map((s) => (
        <div key={s.name}>
          <div
            className="flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 font-medium hover:bg-sidebar-accent"
            onClick={() => toggleSchema(s.name)}
          >
            {effectiveOpenSchemas[s.name] ? (
              <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
            )}
            <span className="min-w-0 flex-1 truncate">{s.name}</span>
            <span className="shrink-0 text-[10px] text-muted-foreground">{s.tables.length}</span>
          </div>
          {effectiveOpenSchemas[s.name] &&
            s.tables.map((t) => {
              const key = `${s.name}.${t.name}`;
              const isOpen = openTables[key];
              return (
                <div key={key} className="ml-3" data-table-row={key}>
                  <div
                    className="group flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 hover:bg-sidebar-accent"
                    onClick={() => toggleTable(s.name, t.name)}
                  >
                    {isOpen ? (
                      <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
                    )}
                    {t.kind === "view" ? (
                      <Eye className="size-3 shrink-0 text-muted-foreground" />
                    ) : (
                      <Table2 className="size-3 shrink-0 text-muted-foreground" />
                    )}
                    <span className="min-w-0 flex-1 truncate">{t.name}</span>
                  </div>
                  {isOpen && (
                    <>
                      <button
                        type="button"
                        onClick={() => browseTable(s.name, t.name)}
                        className="mb-0.5 ml-6 flex w-[calc(100%-1.5rem)] items-center gap-1.5 rounded px-1.5 py-1 text-left text-primary hover:bg-primary/15"
                      >
                        <TableProperties className="size-3 shrink-0" />
                        <span className="text-[11px]">Browse data</span>
                      </button>
                      <div className="ml-6">
                        <div className="mb-0.5 px-1.5 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
                          Columns
                        </div>
                        {t.columns.map((c) => (
                          <div
                            key={c.name}
                            className="flex items-center justify-between gap-2 px-1.5 py-0.5 font-mono text-[11px]"
                          >
                            <span className="truncate">
                              {c.name}
                              {!c.nullable && <span className="text-primary"> *</span>}
                            </span>
                            <span className="shrink-0 text-[10px] text-muted-foreground">
                              {c.data_type}
                            </span>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              );
            })}
        </div>
      ))}
    </div>
  );
}

function cssEscape(s: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(s);
  return s.replace(/(["\\])/g, "\\$1");
}
