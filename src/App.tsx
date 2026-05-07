import { listen } from "@tauri-apps/api/event";
import { lazy, Suspense, useEffect, useState } from "react";
import { Toaster } from "sonner";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ConnectionList } from "./components/ConnectionList";
import { QueryView } from "./components/QueryView";
import { Sidebar } from "./components/Sidebar";
import { TopBar } from "./components/TopBar";
import { UpdateChecker } from "./components/UpdateChecker";
import { useConnections } from "./stores/connections";
import { usePanelLayouts } from "./stores/panelLayouts";
import { useApplyTheme } from "./stores/theme";
import { useUi } from "./stores/ui";
import { useRestoreAndPersistWindowState } from "./stores/windowState";

const CommandPalette = lazy(() =>
  import("./components/CommandPalette").then((m) => ({ default: m.CommandPalette })),
);
const ConnectionForm = lazy(() =>
  import("./components/ConnectionForm").then((m) => ({ default: m.ConnectionForm })),
);
const ExportDatabaseDialog = lazy(() =>
  import("./components/ExportDatabaseDialog").then((m) => ({ default: m.ExportDatabaseDialog })),
);
const ImportSqlDialog = lazy(() =>
  import("./components/ImportSqlDialog").then((m) => ({ default: m.ImportSqlDialog })),
);
const SettingsDialog = lazy(() =>
  import("./components/SettingsDialog").then((m) => ({ default: m.SettingsDialog })),
);

function App() {
  useApplyTheme();
  useRestoreAndPersistWindowState();

  const { load, loaded, activeId } = useConnections();
  const focusSchemaSearch = useUi((s) => s.focusSchemaSearch);
  const exportDialog = useUi((s) => s.exportDialog);
  const importDialog = useUi((s) => s.importDialog);
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [initialFolderId, setInitialFolderId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  const layoutKey = activeId ? "main-with-sidebar" : "main";
  const savedLayout = usePanelLayouts((s) => s.layouts[layoutKey]);
  const setLayout = usePanelLayouts((s) => s.setLayout);

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
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      const key = e.key.toLowerCase();
      if (key === "f") {
        const target = e.target as HTMLElement | null;
        if (target?.closest(".cm-editor")) return;
        e.preventDefault();
        focusSchemaSearch();
      } else if (key === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
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
      <UpdateChecker />
      <Toaster richColors position="bottom-right" />
      <div className="flex h-screen flex-col bg-background text-foreground">
        <TopBar />
        <div className="min-h-0 flex-1">
          <ResizablePanelGroup
            key={layoutKey}
            orientation="horizontal"
            defaultLayout={savedLayout}
            onLayoutChanged={(layout) => setLayout(layoutKey, layout)}
          >
            <ResizablePanel id="connections" defaultSize={18} minSize={8}>
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
                <ResizablePanel id="sidebar" defaultSize={22} minSize={10}>
                  <Sidebar />
                </ResizablePanel>
              </>
            )}
            <ResizableHandle withHandle />
            <ResizablePanel id="query" defaultSize={60} minSize={20}>
              <QueryView />
            </ResizablePanel>
          </ResizablePanelGroup>
        </div>
        <Suspense fallback={null}>
          {formOpen && (
            <ConnectionForm
              editingId={editingId}
              initialFolderId={initialFolderId}
              open={formOpen}
              onOpenChange={setFormOpen}
            />
          )}
          {paletteOpen && <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />}
          {settingsOpen && <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />}
          {exportDialog && <ExportDatabaseDialog />}
          {importDialog && <ImportSqlDialog />}
        </Suspense>
      </div>
    </TooltipProvider>
  );
}

export default App;
