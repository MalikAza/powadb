import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  type FolderFormInput,
  type FolderFormValues,
  folderFormSchema,
  ROOT_FOLDER_SENTINEL,
} from "@/lib/schemas";
import { useConnections } from "../stores/connections";
import type { Folder } from "../types";
import { folderPaths } from "../utils/folderTree";

type Props = {
  editing: Folder | null;
  initialParentId?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function FolderForm({ editing, initialParentId, open, onOpenChange }: Props) {
  const { folders, saveFolder } = useConnections();
  const [submitError, setSubmitError] = useState<string | null>(null);

  const form = useForm<FolderFormInput, unknown, FolderFormValues>({
    resolver: zodResolver(folderFormSchema),
    defaultValues: {
      name: editing?.name ?? "",
      parent_id: editing?.parent_id ?? initialParentId ?? ROOT_FOLDER_SENTINEL,
    },
  });

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

  async function onSubmit(values: FolderFormValues) {
    setSubmitError(null);
    try {
      await saveFolder({
        id: editing?.id,
        name: values.name.trim(),
        parent_id: values.parent_id,
      });
      onOpenChange(false);
    } catch (err) {
      setSubmitError(String(err));
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{editing ? "Rename folder" : "New folder"}</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="grid gap-3">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-xs font-normal text-muted-foreground">Name</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="parent_id"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-xs font-normal text-muted-foreground">
                    Parent folder
                  </FormLabel>
                  <Select
                    value={field.value ?? ROOT_FOLDER_SENTINEL}
                    onValueChange={field.onChange}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value={ROOT_FOLDER_SENTINEL}>(top level)</SelectItem>
                      {paths.map((p) => (
                        <SelectItem key={p.folder.id} value={p.folder.id}>
                          {p.path}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            {submitError && <p className="text-xs text-destructive">{submitError}</p>}

            <DialogFooter className="mt-2">
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={form.formState.isSubmitting}>
                {form.formState.isSubmitting ? "Saving…" : "Save"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
