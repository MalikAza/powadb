import "@xyflow/react/dist/style.css";
import "./diagram.css";
import {
  Background,
  type Connection,
  Controls,
  type Edge,
  type EdgeMouseHandler,
  MiniMap,
  type Node,
  type NodeMouseHandler,
  type NodeTypes,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from "@xyflow/react";
import {
  Database,
  Download,
  FileCode2,
  FileJson,
  FolderOpen,
  ImageIcon,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Save,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ipc, type SavedDiagram } from "@/ipc";
import type { NewTableFormValues } from "@/lib/schemas";
import type { SavedConnection } from "@/types";
import type { DiagramTab } from "../../stores/tabs";
import { useTabs } from "../../stores/tabs";
import { ConfirmDialog } from "../ConfirmDialog";
import { ApplyDialog } from "./dialogs/ApplyDialog";
import { GenerateScriptDialog } from "./dialogs/GenerateScriptDialog";
import { LoadDiagramDialog } from "./dialogs/LoadDiagramDialog";
import { SaveDiagramDialog } from "./dialogs/SaveDiagramDialog";
import { TableFormDialog } from "./dialogs/TableFormDialog";
import {
  addEdge as docAddEdge,
  addTable as docAddTable,
  removeEdge as docRemoveEdge,
  removeTable as docRemoveTable,
  parseHandleId,
  updateTablePosition,
} from "./docHelpers";
import { exportDocAsJpg, exportDocAsJson, exportDocAsPng, exportDocAsSql } from "./exportDiagram";
import { layoutDoc } from "./layout";
import { TableNode } from "./TableNode";
import {
  type DiagramDoc,
  type DiagramTable as DocTable,
  introspectionToDoc,
  syncFkFlags,
} from "./types";

const nodeTypes: NodeTypes = { table: TableNode };

function docToNodes(
  doc: DiagramDoc,
  onEditTable: (id: string) => void,
  onDeleteTable: (id: string) => void,
): Node[] {
  return doc.tables.map((t) => ({
    id: t.id,
    type: "table",
    position: t.position,
    data: { table: t, onEdit: onEditTable, onDelete: onDeleteTable },
  }));
}

function docToEdges(doc: DiagramDoc): Edge[] {
  return doc.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    sourceHandle: `${e.source}.${e.sourceColumns[0]}::source`,
    targetHandle: `${e.target}.${e.targetColumns[0]}::target`,
    type: "default",
    label: e.name ?? undefined,
    labelBgPadding: [4, 2],
    labelBgBorderRadius: 4,
    style: { stroke: "var(--muted-foreground)", strokeWidth: 1.2 },
  }));
}

export function DiagramTabPane(props: { tab: DiagramTab; conn: SavedConnection }) {
  return (
    <ReactFlowProvider>
      <DiagramTabPaneInner {...props} />
    </ReactFlowProvider>
  );
}

function DiagramTabPaneInner({ tab, conn }: { tab: DiagramTab; conn: SavedConnection }) {
  const patchTab = useTabs((s) => s.patchTab);
  const newQueryTab = useTabs((s) => s.newQueryTab);
  const rf = useReactFlow();

  const [doc, setDoc] = useState<DiagramDoc | null>(null);
  const [diagramId, setDiagramId] = useState<string | null>(null);
  const [diagramName, setDiagramName] = useState<string>("");
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  const [tableDialog, setTableDialog] = useState<{ open: boolean; editing: DocTable | null }>({
    open: false,
    editing: null,
  });
  const [saveOpen, setSaveOpen] = useState(false);
  const [loadOpen, setLoadOpen] = useState(false);
  const [scriptOpen, setScriptOpen] = useState(false);
  const [applyOpen, setApplyOpen] = useState(false);
  const [mode, setMode] = useState<"modeler" | "live">(tab.mode);
  // Captured by useCallback handlers (which we memoise with empty deps so they
  // don't churn React Flow's listeners). Reading via ref keeps the handlers
  // tracking the latest mode without re-binding.
  const modeRef = useRef(mode);
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  function maybeAutoApply() {
    if (modeRef.current === "live") setApplyOpen(true);
  }
  const [confirmEdgeDelete, setConfirmEdgeDelete] = useState<string | null>(null);
  const [confirmTableDelete, setConfirmTableDelete] = useState<string | null>(null);

  const structuralKey = useMemo(
    () =>
      doc &&
      `${doc.tables.length}|${doc.edges.length}|${doc.tables.map((t) => t.id).join(",")}|${doc.edges.map((e) => e.id).join(",")}|${doc.engine}`,
    [doc],
  );

  const openEditTable = useCallback((id: string) => {
    setDoc((cur) => {
      const t = cur?.tables.find((x) => x.id === id) ?? null;
      setTableDialog({ open: true, editing: t });
      return cur;
    });
  }, []);

  const askDeleteTable = useCallback((id: string) => {
    setConfirmTableDelete(id);
  }, []);

  useEffect(() => {
    if (!doc) return;
    setNodes(docToNodes(doc, openEditTable, askDeleteTable));
    setEdges(docToEdges(doc));
  }, [structuralKey, doc, openEditTable, askDeleteTable, setNodes, setEdges]);

  const onNodeDragStop: NodeMouseHandler = useCallback((_e, node) => {
    setDoc((cur) => (cur ? updateTablePosition(cur, node.id, node.position) : cur));
    setDirty(true);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const intro = await ipc.introspectDiagram(tab.connectionId);
      patchTab(tab.id, { introspection: intro });
      const raw = introspectionToDoc(intro, conn.kind);
      const laid = await layoutDoc(raw);
      setDoc(laid);
      setDiagramId(null);
      setDiagramName("");
      setDirty(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [tab.connectionId, tab.id, patchTab, conn.kind]);

  useEffect(() => {
    if (!doc) refresh();
  }, [doc, refresh]);

  const onConnect = useCallback((c: Connection) => {
    const sourceTable = c.source;
    const targetTable = c.target;
    if (!sourceTable || !targetTable) return;
    const srcParsed = parseHandleId(c.sourceHandle);
    const tgtParsed = parseHandleId(c.targetHandle);
    if (!srcParsed || !tgtParsed) return;
    setDoc((cur) => {
      if (!cur) return cur;
      const next = docAddEdge(cur, {
        source: sourceTable,
        target: targetTable,
        sourceColumns: [srcParsed.columnName],
        targetColumns: [tgtParsed.columnName],
      });
      if (next !== cur) setDirty(true);
      return next;
    });
    if (modeRef.current === "live") setApplyOpen(true);
  }, []);

  const onEdgeClick: EdgeMouseHandler = useCallback((_e, edge) => {
    setConfirmEdgeDelete(edge.id);
  }, []);

  function handleTableSubmit(values: NewTableFormValues, originalId: string | null) {
    setDoc((cur) => {
      if (!cur) return cur;
      if (originalId) {
        const next = {
          ...cur,
          tables: cur.tables.map((t) => {
            if (t.id !== originalId) return t;
            return {
              ...t,
              name: values.name,
              columns: values.columns.map((c) => ({
                // Preserve identity for edits; mint a fresh id for additions.
                id: c.id ?? `${t.id}.__new__.${c.name}.${Math.random().toString(36).slice(2, 8)}`,
                name: c.name,
                originalName: c.originalName,
                dataType: c.dataType,
                nullable: c.nullable,
                isPk: c.isPk,
                isFk: false,
                defaultValue: c.defaultValue.trim() === "" ? null : c.defaultValue,
              })),
            };
          }),
        };
        setDirty(true);
        return syncFkFlags(next);
      }
      const { doc: nextDoc } = docAddTable(cur, {
        name: values.name,
        columns: values.columns.map((c) => ({
          name: c.name,
          dataType: c.dataType,
          nullable: c.nullable,
          isPk: c.isPk,
          defaultValue: c.defaultValue.trim() === "" ? null : c.defaultValue,
        })),
      });
      setDirty(true);
      return nextDoc;
    });
    maybeAutoApply();
  }

  function loadDiagramFromSaved(saved: SavedDiagram) {
    try {
      const parsed = JSON.parse(saved.doc_json) as DiagramDoc;
      setDoc(parsed);
      setDiagramId(saved.id);
      setDiagramName(saved.name);
      setDirty(false);
      patchTab(tab.id, { diagramId: saved.id, title: saved.name });
    } catch (e) {
      toast.error(`Failed to load diagram: ${String(e)}`);
    }
  }

  function onSaved(savedId: string, savedName: string) {
    setDiagramId(savedId);
    setDiagramName(savedName);
    setDirty(false);
    patchTab(tab.id, { diagramId: savedId, title: savedName });
  }

  function deleteTable(id: string) {
    setDoc((cur) => (cur ? docRemoveTable(cur, id) : cur));
    setDirty(true);
    setConfirmTableDelete(null);
    maybeAutoApply();
  }

  function deleteEdge(id: string) {
    setDoc((cur) => (cur ? docRemoveEdge(cur, id) : cur));
    setDirty(true);
    setConfirmEdgeDelete(null);
    maybeAutoApply();
  }

  function suggestedFilename(): string {
    const base = (diagramName || conn.name || "diagram").replace(/[^a-z0-9-_]+/gi, "-");
    return base.toLowerCase();
  }

  async function doExport(kind: "json" | "sql" | "png" | "jpg") {
    if (!doc) return;
    try {
      let written = false;
      if (kind === "json") written = await exportDocAsJson(doc, suggestedFilename());
      else if (kind === "sql") written = await exportDocAsSql(doc, suggestedFilename());
      else if (kind === "png") written = await exportDocAsPng(rf, suggestedFilename());
      else written = await exportDocAsJpg(rf, suggestedFilename());
      if (written) toast.success(`Exported as ${kind.toUpperCase()}`);
    } catch (e) {
      toast.error(`Export failed: ${String(e)}`);
    }
  }

  const hasLoaded = doc !== null;

  return (
    <div className="relative flex h-full flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-sidebar px-2">
        <Database className="size-3.5 text-muted-foreground" />
        <span className="text-xs font-medium">{conn.name}</span>
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
          {diagramName || "Untitled"}
          {dirty && <span className="ml-1 text-primary">•</span>}
        </span>
        <div className="ml-3 inline-flex overflow-hidden rounded-md border border-border text-[10px]">
          <button
            type="button"
            onClick={() => {
              setMode("modeler");
              patchTab(tab.id, { mode: "modeler" });
            }}
            className={`px-2 py-1 ${
              mode === "modeler"
                ? "bg-primary/15 text-foreground"
                : "text-muted-foreground hover:bg-sidebar-accent"
            }`}
            title="Modeler — edits stay local until you Apply"
          >
            Modeler
          </button>
          <button
            type="button"
            onClick={() => {
              setMode("live");
              patchTab(tab.id, { mode: "live" });
            }}
            className={`flex items-center gap-1 px-2 py-1 ${
              mode === "live"
                ? "bg-amber-500/20 text-foreground"
                : "text-muted-foreground hover:bg-sidebar-accent"
            }`}
            title="Live — each edit runs DDL immediately"
          >
            <Zap className="size-3" /> Live
          </button>
        </div>
        <div className="ml-auto flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 gap-1.5 text-xs"
            onClick={() => setTableDialog({ open: true, editing: null })}
            disabled={!hasLoaded}
            title="Add a new table"
          >
            <Plus className="size-3.5" /> Add table
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 gap-1.5 text-xs"
            onClick={() => setScriptOpen(true)}
            disabled={!hasLoaded || (doc?.tables.length ?? 0) === 0}
            title="Generate SQL DDL script"
          >
            <FileCode2 className="size-3.5" /> Generate script
          </Button>
          <Button
            size="sm"
            variant="default"
            className="h-7 gap-1.5 text-xs"
            onClick={() => setApplyOpen(true)}
            disabled={!hasLoaded}
            title="Diff against the live database and run the resulting ALTER script"
          >
            <Play className="size-3.5" /> Apply to DB…
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 gap-1.5 text-xs"
            onClick={() => setSaveOpen(true)}
            disabled={!hasLoaded}
            title="Save the diagram"
          >
            <Save className="size-3.5" /> Save
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 gap-1.5 text-xs"
            onClick={() => setLoadOpen(true)}
            title="Open a saved diagram"
          >
            <FolderOpen className="size-3.5" /> Load
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 gap-1.5 text-xs"
                disabled={!hasLoaded || (doc?.tables.length ?? 0) === 0}
                title="Export the diagram"
              >
                <Download className="size-3.5" /> Export
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => doExport("json")}>
                <FileJson className="size-3.5" /> JSON (diagram doc)
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => doExport("sql")}>
                <FileCode2 className="size-3.5" /> SQL (DDL script)
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => doExport("png")}>
                <ImageIcon className="size-3.5" /> PNG
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => doExport("jpg")}>
                <ImageIcon className="size-3.5" /> JPEG
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 gap-1.5 text-xs"
            onClick={refresh}
            disabled={loading}
            title="Reload from database"
          >
            {loading ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
            Refresh
          </Button>
        </div>
      </div>

      {error && (
        <div className="border-b border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive">
          {error}
        </div>
      )}

      <div className="relative flex-1 bg-background">
        {loading && !hasLoaded ? (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            <Loader2 className="mr-2 size-3.5 animate-spin" /> Loading schema…
          </div>
        ) : hasLoaded && nodes.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-xs text-muted-foreground">
            <p>No tables yet.</p>
            <Button
              size="sm"
              variant="default"
              onClick={() => setTableDialog({ open: true, editing: null })}
            >
              <Plus className="size-3.5" /> Add your first table
            </Button>
          </div>
        ) : (
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeDragStop={onNodeDragStop}
            onConnect={onConnect}
            onEdgeClick={onEdgeClick}
            nodeTypes={nodeTypes}
            fitView
            minZoom={0.1}
            maxZoom={1.5}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={16} />
            <Controls showInteractive={false} />
            <MiniMap
              pannable
              zoomable
              nodeColor="var(--primary)"
              nodeStrokeColor="var(--primary)"
              maskColor="var(--muted)"
            />
          </ReactFlow>
        )}
      </div>

      <TableFormDialog
        open={tableDialog.open}
        onOpenChange={(o) => setTableDialog({ open: o, editing: o ? tableDialog.editing : null })}
        initial={tableDialog.editing}
        onSubmit={handleTableSubmit}
      />

      {doc && (
        <SaveDiagramDialog
          open={saveOpen}
          onOpenChange={setSaveOpen}
          connectionId={tab.connectionId}
          diagramId={diagramId}
          defaultName={diagramName || `${conn.name} diagram`}
          doc={doc}
          onSaved={onSaved}
        />
      )}

      <LoadDiagramDialog
        open={loadOpen}
        onOpenChange={setLoadOpen}
        connectionId={tab.connectionId}
        onLoad={loadDiagramFromSaved}
      />

      {doc && (
        <GenerateScriptDialog
          open={scriptOpen}
          onOpenChange={setScriptOpen}
          doc={doc}
          onOpenInQueryTab={(script) => {
            newQueryTab(tab.connectionId, script);
          }}
        />
      )}

      {doc && (
        <ApplyDialog
          open={applyOpen}
          onOpenChange={setApplyOpen}
          connectionId={tab.connectionId}
          engine={conn.kind}
          doc={doc}
          onApplied={() => {
            // Re-introspect so originalName + ids reflect the now-current live state.
            refresh();
          }}
        />
      )}

      <ConfirmDialog
        open={confirmEdgeDelete !== null}
        onOpenChange={(o) => {
          if (!o) setConfirmEdgeDelete(null);
        }}
        title="Remove this foreign key?"
        description="The relationship will be removed from the diagram. The underlying database is untouched in Modeler mode."
        confirmLabel="Remove"
        onConfirm={() => confirmEdgeDelete && deleteEdge(confirmEdgeDelete)}
      />

      <ConfirmDialog
        open={confirmTableDelete !== null}
        onOpenChange={(o) => {
          if (!o) setConfirmTableDelete(null);
        }}
        title={`Remove table "${doc?.tables.find((t) => t.id === confirmTableDelete)?.name ?? ""}"?`}
        description="The table and any FKs touching it will be removed from the diagram. The underlying database is untouched in Modeler mode."
        confirmLabel="Remove"
        onConfirm={() => confirmTableDelete && deleteTable(confirmTableDelete)}
      />
    </div>
  );
}
