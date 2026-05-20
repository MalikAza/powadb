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
  Upload,
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
import {
  type DiagIndex,
  type DiagramIntrospection,
  type DiagSequence,
  ipc,
  type SavedDiagram,
} from "@/ipc";
import type { NewTableFormValues } from "@/lib/schemas";
import type { SavedConnection } from "@/types";
import type { DiagramTab } from "../../stores/tabs";
import { useTabs } from "../../stores/tabs";
import { ConfirmDialog } from "../ConfirmDialog";
import { ApplyDialog } from "./dialogs/ApplyDialog";
import { GenerateScriptDialog } from "./dialogs/GenerateScriptDialog";
import { ImportDialog } from "./dialogs/ImportDialog";
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
  intro: DiagramIntrospection | null,
  onEditTable: (id: string) => void,
  onDeleteTable: (id: string) => void,
): Node[] {
  const indexesByTable = new Map<string, DiagIndex[]>();
  const sequencesByTable = new Map<string, DiagSequence[]>();
  if (intro) {
    for (const t of intro.tables) {
      indexesByTable.set(`${t.schema}.${t.name}`, t.indexes ?? []);
    }
    for (const s of intro.sequences ?? []) {
      if (!s.owned_by_schema || !s.owned_by_table) continue;
      const key = `${s.owned_by_schema}.${s.owned_by_table}`;
      const arr = sequencesByTable.get(key) ?? [];
      arr.push(s);
      sequencesByTable.set(key, arr);
    }
  }
  return doc.tables.map((t) => ({
    id: t.id,
    type: "table",
    position: t.position,
    data: {
      table: t,
      indexes: indexesByTable.get(t.id) ?? [],
      sequences: sequencesByTable.get(t.id) ?? [],
      onEdit: onEditTable,
      onDelete: onDeleteTable,
    },
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

type DiagramData = {
  doc: DiagramDoc | null;
  diagramId: string | null;
  diagramName: string;
  dirty: boolean;
  loading: boolean;
  error: string | null;
};

const INITIAL_DIAGRAM: DiagramData = {
  doc: null,
  diagramId: null,
  diagramName: "",
  dirty: false,
  loading: false,
  error: null,
};

type Modals = {
  table: { open: boolean; editing: DocTable | null };
  save: boolean;
  load: boolean;
  script: boolean;
  apply: boolean;
  import: boolean;
};

const INITIAL_MODALS: Modals = {
  table: { open: false, editing: null },
  save: false,
  load: false,
  script: false,
  apply: false,
  import: false,
};

type Confirms = { edgeDelete: string | null; tableDelete: string | null };

function applyTableSubmit(
  cur: DiagramDoc,
  values: NewTableFormValues,
  originalId: string | null,
): DiagramDoc {
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
  return nextDoc;
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

  const [diagram, setDiagram] = useState<DiagramData>(INITIAL_DIAGRAM);
  const { doc, diagramId, diagramName, dirty, loading, error } = diagram;
  const setDoc = (next: DiagramDoc | null | ((cur: DiagramDoc | null) => DiagramDoc | null)) =>
    setDiagram((prev) => ({
      ...prev,
      doc: typeof next === "function" ? next(prev.doc) : next,
    }));
  const setDiagramId = (v: string | null) => setDiagram((prev) => ({ ...prev, diagramId: v }));
  const setDiagramName = (v: string) => setDiagram((prev) => ({ ...prev, diagramName: v }));
  const setDirty = (v: boolean) => setDiagram((prev) => ({ ...prev, dirty: v }));
  const setLoading = (v: boolean) => setDiagram((prev) => ({ ...prev, loading: v }));
  const setError = (v: string | null) => setDiagram((prev) => ({ ...prev, error: v }));

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  const [modals, setModals] = useState<Modals>(INITIAL_MODALS);
  const { table: tableDialog, save: saveOpen, load: loadOpen } = modals;
  const { script: scriptOpen, apply: applyOpen, import: importOpen } = modals;
  const setTableDialog = (v: Modals["table"]) => setModals((prev) => ({ ...prev, table: v }));
  const setSaveOpen = (v: boolean) => setModals((prev) => ({ ...prev, save: v }));
  const setLoadOpen = (v: boolean) => setModals((prev) => ({ ...prev, load: v }));
  const setScriptOpen = (v: boolean) => setModals((prev) => ({ ...prev, script: v }));
  const setApplyOpen = (v: boolean) => setModals((prev) => ({ ...prev, apply: v }));
  const setImportOpen = (v: boolean) => setModals((prev) => ({ ...prev, import: v }));

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

  const [confirms, setConfirms] = useState<Confirms>({ edgeDelete: null, tableDelete: null });
  const { edgeDelete: confirmEdgeDelete, tableDelete: confirmTableDelete } = confirms;
  const setConfirmEdgeDelete = (v: string | null) =>
    setConfirms((prev) => ({ ...prev, edgeDelete: v }));
  const setConfirmTableDelete = (v: string | null) =>
    setConfirms((prev) => ({ ...prev, tableDelete: v }));

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
    setNodes(docToNodes(doc, tab.introspection, openEditTable, askDeleteTable));
    setEdges(docToEdges(doc));
  }, [structuralKey, doc, tab.introspection, openEditTable, askDeleteTable, setNodes, setEdges]);

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
    setDoc((cur) => (cur ? applyTableSubmit(cur, values, originalId) : cur));
    setDirty(true);
    maybeAutoApply();
  }

  function loadDiagramFromSaved(saved: SavedDiagram) {
    try {
      const parsed = JSON.parse(saved.doc_json) as DiagramDoc;
      setDoc(syncFkFlags(parsed));
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

  async function doExport(kind: "json" | "sql" | "png" | "jpg") {
    if (!doc) return;
    const filename = (diagramName || conn.name || "diagram")
      .replace(/[^a-z0-9-_]+/gi, "-")
      .toLowerCase();
    try {
      let written = false;
      if (kind === "json") written = await exportDocAsJson(doc, filename);
      else if (kind === "sql") written = await exportDocAsSql(doc, filename);
      else if (kind === "png") written = await exportDocAsPng(rf, filename);
      else written = await exportDocAsJpg(rf, filename);
      if (written) toast.success(`Exported as ${kind.toUpperCase()}`);
    } catch (e) {
      toast.error(`Export failed: ${String(e)}`);
    }
  }

  const hasLoaded = doc !== null;
  const tableCount = doc?.tables.length ?? 0;
  const onImport = (imported: DiagramDoc, _path: string) => {
    setDoc(imported);
    setDiagramId(null);
    setDiagramName("");
    setDirty(true);
    patchTab(tab.id, { diagramId: null, title: "Imported" });
  };
  const onSwitchMode = (next: "modeler" | "live") => {
    setMode(next);
    patchTab(tab.id, { mode: next });
  };
  const onAddTable = () => setTableDialog({ open: true, editing: null });

  return (
    <div className="relative flex h-full flex-1 flex-col">
      <DiagramToolbar
        connName={conn.name}
        diagramName={diagramName}
        dirty={dirty}
        mode={mode}
        onSwitchMode={onSwitchMode}
        hasLoaded={hasLoaded}
        tableCount={tableCount}
        loading={loading}
        onAddTable={onAddTable}
        onGenerateScript={() => setScriptOpen(true)}
        onApply={() => setApplyOpen(true)}
        onSave={() => setSaveOpen(true)}
        onLoad={() => setLoadOpen(true)}
        onImportOpen={() => setImportOpen(true)}
        onExport={doExport}
        onRefresh={refresh}
      />

      {error && (
        <div className="border-b border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive">
          {error}
        </div>
      )}

      <DiagramCanvas
        loading={loading}
        hasLoaded={hasLoaded}
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStop={onNodeDragStop}
        onConnect={onConnect}
        onEdgeClick={onEdgeClick}
        onAddTable={onAddTable}
      />

      <DiagramDialogs
        doc={doc}
        tableDialog={tableDialog}
        onTableDialogChange={(o) =>
          setTableDialog({ open: o, editing: o ? tableDialog.editing : null })
        }
        onTableSubmit={handleTableSubmit}
        saveOpen={saveOpen}
        setSaveOpen={setSaveOpen}
        connectionId={tab.connectionId}
        diagramId={diagramId}
        defaultSaveName={diagramName || `${conn.name} diagram`}
        onSaved={onSaved}
        loadOpen={loadOpen}
        setLoadOpen={setLoadOpen}
        onLoadDiagram={loadDiagramFromSaved}
        scriptOpen={scriptOpen}
        setScriptOpen={setScriptOpen}
        onOpenInQueryTab={(script) => newQueryTab(tab.connectionId, script)}
        applyOpen={applyOpen}
        setApplyOpen={setApplyOpen}
        engine={conn.kind}
        onApplied={refresh}
        importOpen={importOpen}
        setImportOpen={setImportOpen}
        onImport={onImport}
        confirmEdgeDelete={confirmEdgeDelete}
        onEdgeConfirmChange={(o) => {
          if (!o) setConfirmEdgeDelete(null);
        }}
        onDeleteEdge={deleteEdge}
        confirmTableDelete={confirmTableDelete}
        onTableConfirmChange={(o) => {
          if (!o) setConfirmTableDelete(null);
        }}
        onDeleteTable={deleteTable}
      />
    </div>
  );
}

type DiagramToolbarProps = {
  connName: string;
  diagramName: string;
  dirty: boolean;
  mode: "modeler" | "live";
  onSwitchMode: (next: "modeler" | "live") => void;
  hasLoaded: boolean;
  tableCount: number;
  loading: boolean;
  onAddTable: () => void;
  onGenerateScript: () => void;
  onApply: () => void;
  onSave: () => void;
  onLoad: () => void;
  onImportOpen: () => void;
  onExport: (kind: "json" | "sql" | "png" | "jpg") => void;
  onRefresh: () => void;
};

function DiagramToolbar({
  connName,
  diagramName,
  dirty,
  mode,
  onSwitchMode,
  hasLoaded,
  tableCount,
  loading,
  onAddTable,
  onGenerateScript,
  onApply,
  onSave,
  onLoad,
  onImportOpen,
  onExport,
  onRefresh,
}: DiagramToolbarProps) {
  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-sidebar px-2">
      <Database className="size-3.5 text-muted-foreground" />
      <span className="text-xs font-medium">{connName}</span>
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {diagramName || "Untitled"}
        {dirty && <span className="ml-1 text-primary">•</span>}
      </span>
      <div className="ml-3 inline-flex overflow-hidden rounded-md border border-border text-[10px]">
        <button
          type="button"
          onClick={() => onSwitchMode("modeler")}
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
          onClick={() => onSwitchMode("live")}
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
          onClick={onAddTable}
          disabled={!hasLoaded}
          title="Add a new table"
        >
          <Plus className="size-3.5" /> Add table
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 gap-1.5 text-xs"
          onClick={onGenerateScript}
          disabled={!hasLoaded || tableCount === 0}
          title="Generate SQL DDL script"
        >
          <FileCode2 className="size-3.5" /> Generate script
        </Button>
        <Button
          size="sm"
          variant="default"
          className="h-7 gap-1.5 text-xs"
          onClick={onApply}
          disabled={!hasLoaded}
          title="Diff against the live database and run the resulting ALTER script"
        >
          <Play className="size-3.5" /> Apply to DB…
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 gap-1.5 text-xs"
          onClick={onSave}
          disabled={!hasLoaded}
          title="Save the diagram"
        >
          <Save className="size-3.5" /> Save
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 gap-1.5 text-xs"
          onClick={onLoad}
          title="Open a saved diagram"
        >
          <FolderOpen className="size-3.5" /> Load
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 gap-1.5 text-xs"
          onClick={onImportOpen}
          title="Import a diagram from a JSON or SQL file"
        >
          <Upload className="size-3.5" /> Import
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 gap-1.5 text-xs"
              disabled={!hasLoaded || tableCount === 0}
              title="Export the diagram"
            >
              <Download className="size-3.5" /> Export
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => onExport("json")}>
              <FileJson className="size-3.5" /> JSON (diagram doc)
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onExport("sql")}>
              <FileCode2 className="size-3.5" /> SQL (DDL script)
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onExport("png")}>
              <ImageIcon className="size-3.5" /> PNG
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onExport("jpg")}>
              <ImageIcon className="size-3.5" /> JPEG
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 gap-1.5 text-xs"
          onClick={onRefresh}
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
  );
}

type DiagramCanvasProps = {
  loading: boolean;
  hasLoaded: boolean;
  nodes: Node[];
  edges: Edge[];
  onNodesChange: React.ComponentProps<typeof ReactFlow>["onNodesChange"];
  onEdgesChange: React.ComponentProps<typeof ReactFlow>["onEdgesChange"];
  onNodeDragStop: NodeMouseHandler;
  onConnect: (c: Connection) => void;
  onEdgeClick: EdgeMouseHandler;
  onAddTable: () => void;
};

function DiagramCanvas({
  loading,
  hasLoaded,
  nodes,
  edges,
  onNodesChange,
  onEdgesChange,
  onNodeDragStop,
  onConnect,
  onEdgeClick,
  onAddTable,
}: DiagramCanvasProps) {
  return (
    <div className="relative flex-1 bg-background">
      {loading && !hasLoaded ? (
        <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
          <Loader2 className="mr-2 size-3.5 animate-spin" /> Loading schema…
        </div>
      ) : hasLoaded && nodes.length === 0 ? (
        <div className="flex h-full flex-col items-center justify-center gap-3 text-xs text-muted-foreground">
          <p>No tables yet.</p>
          <Button size="sm" variant="default" onClick={onAddTable}>
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
  );
}

type DiagramDialogsProps = {
  doc: DiagramDoc | null;
  tableDialog: { open: boolean; editing: DocTable | null };
  onTableDialogChange: (o: boolean) => void;
  onTableSubmit: (values: NewTableFormValues, originalId: string | null) => void;
  saveOpen: boolean;
  setSaveOpen: (v: boolean) => void;
  connectionId: string;
  diagramId: string | null;
  defaultSaveName: string;
  onSaved: (savedId: string, savedName: string) => void;
  loadOpen: boolean;
  setLoadOpen: (v: boolean) => void;
  onLoadDiagram: (saved: SavedDiagram) => void;
  scriptOpen: boolean;
  setScriptOpen: (v: boolean) => void;
  onOpenInQueryTab: (script: string) => void;
  applyOpen: boolean;
  setApplyOpen: (v: boolean) => void;
  engine: SavedConnection["kind"];
  onApplied: () => void;
  importOpen: boolean;
  setImportOpen: (v: boolean) => void;
  onImport: (imported: DiagramDoc, path: string) => void;
  confirmEdgeDelete: string | null;
  onEdgeConfirmChange: (o: boolean) => void;
  onDeleteEdge: (id: string) => void;
  confirmTableDelete: string | null;
  onTableConfirmChange: (o: boolean) => void;
  onDeleteTable: (id: string) => void;
};

function DiagramDialogs({
  doc,
  tableDialog,
  onTableDialogChange,
  onTableSubmit,
  saveOpen,
  setSaveOpen,
  connectionId,
  diagramId,
  defaultSaveName,
  onSaved,
  loadOpen,
  setLoadOpen,
  onLoadDiagram,
  scriptOpen,
  setScriptOpen,
  onOpenInQueryTab,
  applyOpen,
  setApplyOpen,
  engine,
  onApplied,
  importOpen,
  setImportOpen,
  onImport,
  confirmEdgeDelete,
  onEdgeConfirmChange,
  onDeleteEdge,
  confirmTableDelete,
  onTableConfirmChange,
  onDeleteTable,
}: DiagramDialogsProps) {
  return (
    <>
      <TableFormDialog
        open={tableDialog.open}
        onOpenChange={onTableDialogChange}
        initial={tableDialog.editing}
        onSubmit={onTableSubmit}
      />

      {doc && (
        <SaveDiagramDialog
          open={saveOpen}
          onOpenChange={setSaveOpen}
          connectionId={connectionId}
          diagramId={diagramId}
          defaultName={defaultSaveName}
          doc={doc}
          onSaved={onSaved}
        />
      )}

      <LoadDiagramDialog
        open={loadOpen}
        onOpenChange={setLoadOpen}
        connectionId={connectionId}
        onLoad={onLoadDiagram}
      />

      {doc && (
        <GenerateScriptDialog
          open={scriptOpen}
          onOpenChange={setScriptOpen}
          doc={doc}
          onOpenInQueryTab={onOpenInQueryTab}
        />
      )}

      {doc && (
        <ApplyDialog
          open={applyOpen}
          onOpenChange={setApplyOpen}
          connectionId={connectionId}
          engine={engine}
          doc={doc}
          onApplied={onApplied}
        />
      )}

      <ImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        engine={engine}
        onImport={onImport}
      />

      <ConfirmDialog
        open={confirmEdgeDelete !== null}
        onOpenChange={onEdgeConfirmChange}
        title="Remove this foreign key?"
        description="The relationship will be removed from the diagram. The underlying database is untouched in Modeler mode."
        confirmLabel="Remove"
        onConfirm={() => confirmEdgeDelete && onDeleteEdge(confirmEdgeDelete)}
      />

      <ConfirmDialog
        open={confirmTableDelete !== null}
        onOpenChange={onTableConfirmChange}
        title={`Remove table "${doc?.tables.find((t) => t.id === confirmTableDelete)?.name ?? ""}"?`}
        description="The table and any FKs touching it will be removed from the diagram. The underlying database is untouched in Modeler mode."
        confirmLabel="Remove"
        onConfirm={() => confirmTableDelete && onDeleteTable(confirmTableDelete)}
      />
    </>
  );
}
