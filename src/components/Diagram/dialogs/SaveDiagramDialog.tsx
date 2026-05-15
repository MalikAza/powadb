import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ipc } from "@/ipc";
import type { DiagramDoc } from "../types";

export function SaveDiagramDialog({
  open,
  onOpenChange,
  connectionId,
  diagramId,
  defaultName,
  doc,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connectionId: string;
  diagramId: string | null;
  defaultName: string;
  doc: DiagramDoc;
  onSaved: (savedId: string, savedName: string) => void;
}) {
  const [name, setName] = useState(defaultName);
  const [busy, setBusy] = useState(false);
  const isUpdate = diagramId !== null;

  useEffect(() => {
    if (open) setName(defaultName);
  }, [open, defaultName]);

  async function save() {
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      const result = await ipc.saveDiagram({
        id: diagramId ?? undefined,
        connection_id: connectionId,
        name: trimmed,
        doc_json: JSON.stringify(doc),
      });
      toast.success(isUpdate ? "Diagram updated" : `Saved as "${trimmed}"`);
      onSaved(result.id, result.name);
      onOpenChange(false);
    } catch (e) {
      toast.error(`Failed to save: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isUpdate ? "Update diagram" : "Save diagram"}</DialogTitle>
        </DialogHeader>
        <div>
          <Label htmlFor="diagram-name">Name</Label>
          <Input
            id="diagram-name"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="schema-overview"
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
            }}
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy || !name.trim()}>
            {busy ? "Saving…" : isUpdate ? "Update" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
