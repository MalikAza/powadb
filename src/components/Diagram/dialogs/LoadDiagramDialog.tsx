import { Loader2, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ipc, type SavedDiagram } from "@/ipc";

export function LoadDiagramDialog({
  open,
  onOpenChange,
  connectionId,
  onLoad,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connectionId: string;
  onLoad: (diagram: SavedDiagram) => void;
}) {
  const [items, setItems] = useState<SavedDiagram[] | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    ipc
      .listDiagrams(connectionId)
      .then(setItems)
      .catch((e) => toast.error(`Failed to list diagrams: ${String(e)}`))
      .finally(() => setLoading(false));
  }, [open, connectionId]);

  async function remove(id: string) {
    try {
      await ipc.deleteDiagram(id);
      setItems((cur) => (cur ? cur.filter((d) => d.id !== id) : cur));
      toast.success("Diagram deleted");
    } catch (e) {
      toast.error(`Failed to delete: ${String(e)}`);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Load diagram</DialogTitle>
        </DialogHeader>
        <div className="max-h-80 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading…
            </div>
          ) : !items || items.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted-foreground">
              No saved diagrams for this connection.
            </p>
          ) : (
            <div className="divide-y divide-border">
              {items.map((d) => (
                <div key={d.id} className="flex items-center gap-2 py-2">
                  <button
                    type="button"
                    onClick={() => {
                      onLoad(d);
                      onOpenChange(false);
                    }}
                    className="flex min-w-0 flex-1 flex-col items-start rounded px-2 py-1 text-left hover:bg-sidebar-accent"
                  >
                    <span className="truncate text-sm font-medium">{d.name}</span>
                    <span className="text-[10px] text-muted-foreground">
                      Updated {d.updated_at}
                    </span>
                  </button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-7 text-muted-foreground hover:text-destructive"
                    onClick={() => remove(d.id)}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
