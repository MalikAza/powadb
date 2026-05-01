import { useEffect, useState } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { CommandPalette } from "./components/CommandPalette";
import { ConnectionForm } from "./components/ConnectionForm";
import { ConnectionList } from "./components/ConnectionList";
import { QueryView } from "./components/QueryView";
import { Sidebar } from "./components/Sidebar";
import { TopBar } from "./components/TopBar";
import { useConnections } from "./stores/connections";

function App() {
  const { load, loaded, activeId } = useConnections();
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [initialFolderId, setInitialFolderId] = useState<string | null>(null);

  useEffect(() => {
    load();
  }, [load]);

  if (!loaded) {
    return (
      <div className="flex h-screen items-center justify-center text-muted-foreground">
        Loading…
      </div>
    );
  }

  return (
    <TooltipProvider delayDuration={150}>
      <div className="flex h-screen flex-col bg-background text-foreground">
        <TopBar />
        <div className="min-h-0 flex-1">
          <ResizablePanelGroup orientation="horizontal">
            <ResizablePanel defaultSize={18} minSize={8}>
              <ConnectionList
                onAdd={(folderId) => {
                  setEditingId(null);
                  setInitialFolderId(folderId ?? null);
                  setFormOpen(true);
                }}
                onEdit={(id) => {
                  setEditingId(id);
                  setInitialFolderId(null);
                  setFormOpen(true);
                }}
              />
            </ResizablePanel>
            {activeId && (
              <>
                <ResizableHandle withHandle />
                <ResizablePanel defaultSize={22} minSize={10}>
                  <Sidebar />
                </ResizablePanel>
              </>
            )}
            <ResizableHandle withHandle />
            <ResizablePanel defaultSize={60} minSize={20}>
              <QueryView />
            </ResizablePanel>
          </ResizablePanelGroup>
        </div>
        {formOpen && (
          <ConnectionForm
            editingId={editingId}
            initialFolderId={initialFolderId}
            open={formOpen}
            onOpenChange={setFormOpen}
          />
        )}
        <CommandPalette />
      </div>
    </TooltipProvider>
  );
}

export default App;
