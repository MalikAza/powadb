import { useState } from "react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useConnections } from "../stores/connections";
import type { Folder } from "../types";
import { folderPaths } from "../utils/folderTree";

type Props = {
  editing: Folder | null;
  initialParentId?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

const ROOT = "__root__";

export function FolderForm({ editing, initialParentId, open, onOpenChange }: Props) {
  const { folders, saveFolder } = useConnections();

  const [name, setName] = useState(editing?.name ?? "");
  const [parentId, setParentId] = useState<string>(editing?.parent_id ?? initialParentId ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Forbid setting a folder as a child of itself or its descendants
  const forbiddenIds = new Set<string>();
  if (editing) {
    const queue = [editing.id];
    while (queue.length) {
      const id = queue.shift()!;
      forbiddenIds.add(id);
      for (const f of folders) if (f.parent_id === id) queue.push(f.id);
    }
  }

  const paths = folderPaths(folders).filter((p) => !forbiddenIds.has(p.folder.id));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await saveFolder({
        id: editing?.id,
        name: name.trim(),
        parent_id: parentId === ROOT || !parentId ? null : parentId,
      });
      onOpenChange(false);
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{editing ? "Rename folder" : "New folder"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-3">
          <div className="grid gap-1.5">
            <Label className="text-xs font-normal text-muted-foreground">Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus required />
          </div>
          <div className="grid gap-1.5">
            <Label className="text-xs font-normal text-muted-foreground">Parent folder</Label>
            <Select
              value={parentId || ROOT}
              onValueChange={(v) => setParentId(v === ROOT ? "" : v)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ROOT}>(top level)</SelectItem>
                {paths.map((p) => (
                  <SelectItem key={p.folder.id} value={p.folder.id}>
                    {p.path}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <DialogFooter className="mt-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || !name.trim()}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
