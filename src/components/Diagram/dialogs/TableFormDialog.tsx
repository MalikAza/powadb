import { zodResolver } from "@hookform/resolvers/zod";
import { Plus, Trash2 } from "lucide-react";
import { useFieldArray, useForm } from "react-hook-form";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { type NewTableFormValues, newTableFormSchema } from "@/lib/schemas";
import type { DiagramTable } from "../types";

export type TableFormSubmit = (values: NewTableFormValues, originalId: string | null) => void;

export function TableFormDialog({
  open,
  onOpenChange,
  initial,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: DiagramTable | null;
  onSubmit: TableFormSubmit;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{initial ? `Edit table "${initial.name}"` : "New table"}</DialogTitle>
        </DialogHeader>
        {open && (
          // Re-key on the table being edited so a fresh form mounts cleanly
          // instead of reset-looping via useEffect on a fresh `defaults` object.
          <TableFormBody
            key={initial?.id ?? "__new__"}
            initial={initial}
            onSubmit={onSubmit}
            onClose={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function TableFormBody({
  initial,
  onSubmit,
  onClose,
}: {
  initial: DiagramTable | null;
  onSubmit: TableFormSubmit;
  onClose: () => void;
}) {
  const defaults: NewTableFormValues = initial
    ? {
        name: initial.name,
        columns: initial.columns.map((c) => ({
          name: c.name,
          dataType: c.dataType,
          nullable: c.nullable,
          isPk: c.isPk,
          defaultValue: c.defaultValue ?? "",
        })),
      }
    : {
        name: "",
        columns: [
          { name: "id", dataType: "integer", nullable: false, isPk: true, defaultValue: "" },
        ],
      };

  const form = useForm<NewTableFormValues>({
    resolver: zodResolver(newTableFormSchema),
    defaultValues: defaults,
  });
  const { fields, append, remove } = useFieldArray({ control: form.control, name: "columns" });

  const submit = form.handleSubmit((values) => {
    onSubmit(values, initial?.id ?? null);
    onClose();
  });

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="table-name">Table name</Label>
        <Input id="table-name" autoFocus {...form.register("name")} placeholder="users" />
        {form.formState.errors.name && (
          <p className="mt-1 text-xs text-destructive">{form.formState.errors.name.message}</p>
        )}
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <Label>Columns</Label>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 gap-1.5 text-xs"
            onClick={() =>
              append({ name: "", dataType: "text", nullable: true, isPk: false, defaultValue: "" })
            }
          >
            <Plus className="size-3.5" /> Add column
          </Button>
        </div>

        <div className="space-y-1.5">
          <div className="grid grid-cols-[1fr_1fr_56px_56px_1fr_28px] items-center gap-1.5 px-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            <span>Name</span>
            <span>Type</span>
            <span className="text-center">PK</span>
            <span className="text-center">Null</span>
            <span>Default</span>
            <span />
          </div>
          {fields.map((field, i) => (
            <div
              key={field.id}
              className="grid grid-cols-[1fr_1fr_56px_56px_1fr_28px] items-center gap-1.5"
            >
              <Input
                {...form.register(`columns.${i}.name`)}
                placeholder="column"
                className="h-7 text-xs"
              />
              <Input
                {...form.register(`columns.${i}.dataType`)}
                placeholder="integer"
                className="h-7 text-xs"
              />
              <div className="flex justify-center">
                <Checkbox
                  checked={form.watch(`columns.${i}.isPk`)}
                  onCheckedChange={(v) => form.setValue(`columns.${i}.isPk`, !!v)}
                />
              </div>
              <div className="flex justify-center">
                <Checkbox
                  checked={form.watch(`columns.${i}.nullable`)}
                  onCheckedChange={(v) => form.setValue(`columns.${i}.nullable`, !!v)}
                />
              </div>
              <Input
                {...form.register(`columns.${i}.defaultValue`)}
                placeholder="—"
                className="h-7 text-xs"
              />
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="size-6 text-muted-foreground hover:text-destructive"
                onClick={() => remove(i)}
                disabled={fields.length <= 1}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          ))}
        </div>

        {form.formState.errors.columns &&
          typeof form.formState.errors.columns.message === "string" && (
            <p className="mt-2 text-xs text-destructive">{form.formState.errors.columns.message}</p>
          )}
        {Array.isArray(form.formState.errors.columns) &&
          form.formState.errors.columns.map((err, i) =>
            err?.name ? (
              <p key={`${i}-${err.name.message}`} className="mt-1 text-xs text-destructive">
                Column #{i + 1}: {err.name.message}
              </p>
            ) : null,
          )}
      </div>

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit">{initial ? "Save changes" : "Add table"}</Button>
      </DialogFooter>
    </form>
  );
}
