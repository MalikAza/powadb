import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export type CellPreview = { columnName: string; value: unknown };

export function CellPreviewDialog({
  preview,
  onOpenChange,
}: {
  preview: CellPreview | null;
  onOpenChange: (open: boolean) => void;
}) {
  const text =
    preview === null
      ? ""
      : preview.value === null || preview.value === undefined
        ? "NULL"
        : typeof preview.value === "object"
          ? JSON.stringify(preview.value, null, 2)
          : String(preview.value);
  return (
    <Dialog open={preview !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="font-mono">{preview?.columnName ?? ""}</DialogTitle>
        </DialogHeader>
        <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-all rounded-md border border-border bg-muted/50 p-3 font-mono text-xs">
          {text}
        </pre>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              navigator.clipboard.writeText(text);
            }}
          >
            Copy
          </Button>
          <Button onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
