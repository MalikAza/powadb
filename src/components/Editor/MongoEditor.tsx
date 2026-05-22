import { acceptCompletion, autocompletion, completionStatus } from "@codemirror/autocomplete";
import { indentWithTab } from "@codemirror/commands";
import { json } from "@codemirror/lang-json";
import { highlightSelectionMatches, search } from "@codemirror/search";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { useEffect, useMemo, useRef, useState } from "react";
import { useConnections } from "../../stores/connections";
import { useSchema } from "../../stores/schema";
import {
  type CmRuntime,
  getCachedCmRuntime,
  loadCmRuntime,
  selectionAwareActiveLine,
} from "./cmRuntime";
import { buildMongoCompletionSource } from "./mongoCompletions";

type Props = {
  value: string;
  onChange: (next: string) => void;
  onRun: () => void;
};

const PLACEHOLDER =
  '// mongosh-style — Cmd+Enter to run.\n// use myDatabase;\n// db.users.find({ active: true }).limit(25)\n// db.users.findOne({ _id: ObjectId("...") })\n// db.orders.aggregate([{ $match: {...} }, { $group: {...} }])';

export function MongoEditor({ value, onChange, onRun }: Props) {
  const activeId = useConnections((s) => s.activeId);
  const schemas = useSchema((s) => (activeId ? s.byConnection[activeId] : undefined));
  const editorRef = useRef<ReactCodeMirrorRef | null>(null);
  const [runtime, setRuntime] = useState<CmRuntime | null>(() => getCachedCmRuntime());

  useEffect(() => {
    editorRef.current?.view?.focus();
  }, []);

  useEffect(() => {
    if (!runtime) {
      loadCmRuntime().then(setRuntime);
    }
  }, [runtime]);

  const completionSource = useMemo(() => buildMongoCompletionSource(schemas), [schemas]);

  const extensions = useMemo(() => {
    if (!runtime) return null;
    const { EditorView, keymap, placeholder, precHighest, theme } = runtime;
    return [
      json(),
      precHighest(
        keymap.of([
          {
            key: "Mod-Enter",
            preventDefault: true,
            run: () => {
              onRun();
              return true;
            },
          },
          {
            key: "Tab",
            run: (view) => {
              if (completionStatus(view.state) === "active") return acceptCompletion(view);
              return false;
            },
          },
          indentWithTab,
        ]),
      ),
      autocompletion({
        activateOnTyping: true,
        closeOnBlur: true,
        defaultKeymap: true,
        icons: false,
        override: [completionSource],
      }),
      search({ top: true }),
      highlightSelectionMatches(),
      selectionAwareActiveLine(runtime),
      placeholder(PLACEHOLDER),
      theme.cmAppTheme,
      theme.cmHighlightStyle,
      EditorView.theme({
        "&": { height: "100%", fontSize: "13px" },
      }),
    ];
  }, [onRun, runtime, completionSource]);

  if (!extensions) return null;

  return (
    <CodeMirror
      ref={editorRef}
      value={value}
      onChange={onChange}
      theme="none"
      height="100%"
      selection={{ anchor: value.length }}
      extensions={extensions}
      basicSetup={{
        lineNumbers: true,
        // Replaced by `selectionAwareActiveLine`; see SqlEditor for context.
        highlightActiveLine: false,
        highlightSelectionMatches: false,
        bracketMatching: true,
        closeBrackets: true,
        autocompletion: false,
        searchKeymap: false,
      }}
      style={{ flex: 1, minHeight: 0, overflow: "hidden" }}
    />
  );
}
