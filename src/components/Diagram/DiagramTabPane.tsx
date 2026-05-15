import "@xyflow/react/dist/style.css";
import "./diagram.css";
import {
  Background,
  Controls,
  type Edge,
  MiniMap,
  type Node,
  type NodeTypes,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
} from "@xyflow/react";
import { Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ipc } from "@/ipc";
import type { SavedConnection } from "@/types";
import type { DiagramTab } from "../../stores/tabs";
import { useTabs } from "../../stores/tabs";
import { layoutDoc } from "./layout";
import { TableNode } from "./TableNode";
import { type DiagramDoc, introspectionToDoc } from "./types";

const nodeTypes: NodeTypes = { table: TableNode };

function docToNodes(doc: DiagramDoc): Node[] {
  return doc.tables.map((t) => ({
    id: t.id,
    type: "table",
    position: t.position,
    data: { table: t },
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

export function DiagramTabPane({ tab, conn }: { tab: DiagramTab; conn: SavedConnection }) {
  const patchTab = useTabs((s) => s.patchTab);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const intro = await ipc.introspectDiagram(tab.connectionId);
      patchTab(tab.id, { introspection: intro });
      const raw = introspectionToDoc(intro);
      const laid = await layoutDoc(raw);
      setNodes(docToNodes(laid));
      setEdges(docToEdges(laid));
      setHasLoaded(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [tab.connectionId, tab.id, patchTab, setNodes, setEdges]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <div className="relative flex h-full flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-sidebar px-2">
        <span className="text-xs font-medium">{conn.name}</span>
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
          Diagram · {tab.mode}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 gap-1.5 text-xs"
            onClick={refresh}
            disabled={loading}
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
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            No tables found in this connection.
          </div>
        ) : (
          <ReactFlowProvider>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
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
          </ReactFlowProvider>
        )}
      </div>
    </div>
  );
}
