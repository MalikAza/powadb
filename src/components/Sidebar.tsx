import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useConnections } from "../stores/connections";
import { type SidebarPane, useUi } from "../stores/ui";
import { HistoryPanel } from "./HistoryPanel";
import { SchemaTree } from "./SchemaTree";
import { SnippetsPanel } from "./SnippetsPanel";

export function Sidebar() {
  const { activeId } = useConnections();
  const pane = useUi((s) => s.pane);
  const setPane = useUi((s) => s.setPane);

  if (!activeId) return null;

  return (
    <div className="flex h-full flex-col bg-sidebar">
      <Tabs
        value={pane}
        onValueChange={(v) => setPane(v as SidebarPane)}
        className="flex h-full flex-col gap-0"
      >
        <TabsList className="h-9 w-full rounded-none border-b border-sidebar-border bg-transparent p-0">
          <TabsTrigger
            value="schema"
            className="h-full flex-1 rounded-none border-0 border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none"
          >
            Schema
          </TabsTrigger>
          <TabsTrigger
            value="history"
            className="h-full flex-1 rounded-none border-0 border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none"
          >
            History
          </TabsTrigger>
          <TabsTrigger
            value="snippets"
            className="h-full flex-1 rounded-none border-0 border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none"
          >
            Snippets
          </TabsTrigger>
        </TabsList>
        <TabsContent value="schema" className="m-0 min-h-0 flex-1 overflow-y-auto p-2">
          <SchemaTree />
        </TabsContent>
        <TabsContent value="history" className="m-0 min-h-0 flex-1 overflow-y-auto p-2">
          <HistoryPanel />
        </TabsContent>
        <TabsContent value="snippets" className="m-0 min-h-0 flex-1 overflow-y-auto p-2">
          <SnippetsPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}
