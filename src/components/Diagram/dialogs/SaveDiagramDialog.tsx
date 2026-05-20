import { useRef, useState } from "react";
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

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connectionId: string;
  diagramId: string | null;
  defaultName: string;
  doc: DiagramDoc;
  onSaved: (savedId: string, savedName: string) => void;
};

export function SaveDiagramDialog(props: Props) {
  // Remount the form whenever the dialog opens (or its name seed changes) so
  // input + busy state reset without a useState→useEffect sync.
  const formKey = props.open ? `${props.diagramId ?? "new"}::${props.defaultName}` : "closed";
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <SaveDiagramForm key={formKey} {...props} />
      </DialogContent>
    </Dialog>
  );
}

function SaveDiagramForm({
  onOpenChange,
  connectionId,
  diagramId,
  defaultName,
  doc,
  onSaved,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  // Seeded true: callers always pass a non-empty defaultName. The onInput
  // handler keeps this in sync as the user edits.
  const [hasName, setHasName] = useState(true);
  const [busy, setBusy] = useState(false);
  const isUpdate = diagramId !== null;

  async function save() {
    const trimmed = (inputRef.current?.value ?? "").trim();
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
    <>
      <DialogHeader>
        <DialogTitle>{isUpdate ? "Update diagram" : "Save diagram"}</DialogTitle>
      </DialogHeader>
      <div>
        <Label htmlFor="diagram-name">Name</Label>
        <Input
          id="diagram-name"
          ref={inputRef}
          defaultValue={defaultName}
          onInput={(e) => setHasName((e.target as HTMLInputElement).value.trim().length > 0)}
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
        <Button onClick={save} disabled={busy || !hasName}>
          {busy ? "Saving…" : isUpdate ? "Update" : "Save"}
        </Button>
      </DialogFooter>
    </>
  );
}
