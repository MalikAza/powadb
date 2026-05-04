import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CommandPalette } from "./components/CommandPalette";
import { ConnectionForm } from "./components/ConnectionForm";
import { ConnectionList } from "./components/ConnectionList";
import { ExportDatabaseDialog } from "./components/ExportDatabaseDialog";
import { ImportSqlDialog } from "./components/ImportSqlDialog";
import { QueryView } from "./components/QueryView";
import { SettingsDialog } from "./components/SettingsDialog";
import { Sidebar } from "./components/Sidebar";
import { TopBar } from "./components/TopBar";
import { useConnections } from "./stores/connections";
import { useApplyTheme } from "./stores/theme";
import { useUi } from "./stores/ui";

function App() {
  useApplyTheme();

  const { load, loaded, activeId } = useConnections();
  const focusSchemaSearch = useUi((s) => s.focusSchemaSearch);
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [initialFolderId, setInitialFolderId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const unlisten = listen("open-settings", () => setSettingsOpen(true));
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "f") return;
      const target = e.target as HTMLElement | null;
      if (target?.closest(".cm-editor")) return;
      e.preventDefault();
      focusSchemaSearch();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focusSchemaSearch]);

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
        <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
        <ExportDatabaseDialog />
        <ImportSqlDialog />
      </div>
    </TooltipProvider>
  );
}

export default App;
