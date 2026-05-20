import { sql } from "@codemirror/lang-sql";
import CodeMirror from "@uiw/react-codemirror";
import { Check, Copy, FileText, Loader2 } from "lucide-react";
import { useEffect, useReducer, useState } from "react";
import { toast } from "sonner";
import { cmAppTheme, cmHighlightStyle } from "@/components/Editor/editorTheme";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ipc } from "@/ipc";
import type { DiagramDoc } from "../types";

export function GenerateScriptDialog({
  open,
  onOpenChange,
  doc,
  onOpenInQueryTab,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  doc: DiagramDoc;
  onOpenInQueryTab?: (script: string) => void;
}) {
  type FetchState =
    | { status: "idle"; script: string; error: null }
    | { status: "loading"; script: string; error: null }
    | { status: "success"; script: string; error: null }
    | { status: "error"; script: string; error: string };
  type FetchAction =
    | { type: "load" }
    | { type: "success"; script: string }
    | { type: "fail"; error: string };
  const [fetchState, dispatchFetch] = useReducer(
    (s: FetchState, a: FetchAction): FetchState => {
      switch (a.type) {
        case "load":
          return { status: "loading", script: s.script, error: null };
        case "success":
          return { status: "success", script: a.script, error: null };
        case "fail":
          return { status: "error", script: s.script, error: a.error };
      }
    },
    { status: "idle", script: "", error: null },
  );
  const { script, error } = fetchState;
  const loading = fetchState.status === "loading";
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    dispatchFetch({ type: "load" });
    ipc
      .generateDiagramDdl(JSON.stringify(doc), doc.engine)
      .then((s) => dispatchFetch({ type: "success", script: s }))
      .catch((e) => dispatchFetch({ type: "fail", error: String(e) }));
  }, [open, doc]);

  function copy() {
    navigator.clipboard.writeText(script).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
        toast.success("Copied to clipboard");
      },
      () => toast.error("Copy failed"),
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Generate SQL script</DialogTitle>
        </DialogHeader>
        <div className="flex h-96 flex-col overflow-hidden rounded-md border border-border">
          {loading ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 size-4 animate-spin" /> Generating…
            </div>
          ) : error ? (
            <p className="p-4 text-sm text-destructive">{error}</p>
          ) : (
            <div className="min-h-0 flex-1 overflow-auto">
              <CodeMirror
                value={script}
                height="100%"
                extensions={[sql(), cmAppTheme, cmHighlightStyle]}
                editable={false}
                basicSetup={{
                  lineNumbers: true,
                  foldGutter: false,
                  highlightActiveLine: false,
                  highlightActiveLineGutter: false,
                }}
                theme="none"
              />
            </div>
          )}
        </div>
        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          {onOpenInQueryTab && (
            <Button
              variant="ghost"
              onClick={() => {
                onOpenInQueryTab(script);
                onOpenChange(false);
              }}
              disabled={!script || loading}
            >
              <FileText className="size-3.5" /> Open in query tab
            </Button>
          )}
          <Button onClick={copy} disabled={!script || loading}>
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            {copied ? "Copied" : "Copy"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
