import { acceptCompletion, autocompletion, completionStatus } from "@codemirror/autocomplete";
import { indentWithTab } from "@codemirror/commands";
import { MySQL, PostgreSQL, SQLite, sql } from "@codemirror/lang-sql";
import { highlightSelectionMatches, search } from "@codemirror/search";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { useEffect, useMemo, useRef, useState } from "react";
import { useConnections } from "../../stores/connections";
import { buildCmSchema, useSchema } from "../../stores/schema";
import type { DbKind } from "../../types";
import { type EditorThemeBundle, loadEditorTheme } from "./editorTheme";

// @codemirror/view and @codemirror/state are loaded via dynamic import() so
// they ship in this lazy chunk only (SqlEditor is itself React.lazy'd).
type PrecHighest = <T>(ext: T) => T;
type CmRuntime = {
  EditorView: typeof import("@codemirror/view").EditorView;
  keymap: typeof import("@codemirror/view").keymap;
  placeholder: typeof import("@codemirror/view").placeholder;
  precHighest: PrecHighest;
  theme: EditorThemeBundle;
};

let cachedRuntime: CmRuntime | null = null;
function loadCmRuntime(): Promise<CmRuntime> {
  if (cachedRuntime) return Promise.resolve(cachedRuntime);
  return Promise.all([
    import("@codemirror/view"),
    import("@codemirror/state"),
    loadEditorTheme(),
  ]).then(([view, state, theme]) => {
    cachedRuntime = {
      EditorView: view.EditorView,
      keymap: view.keymap,
      placeholder: view.placeholder,
      precHighest: state.Prec.highest as PrecHighest,
      theme,
    };
    return cachedRuntime;
  });
}

type Props = {
  value: string;
  onChange: (next: string) => void;
  onRun: () => void;
  kind: DbKind;
};

export function SqlEditor({ value, onChange, onRun, kind }: Props) {
  const activeId = useConnections((s) => s.activeId);
  const schemas = useSchema((s) => (activeId ? s.byConnection[activeId] : undefined));
  const editorRef = useRef<ReactCodeMirrorRef | null>(null);
  const [runtime, setRuntime] = useState<CmRuntime | null>(cachedRuntime);

  useEffect(() => {
    editorRef.current?.view?.focus();
  }, []);

  useEffect(() => {
    if (!runtime) {
      loadCmRuntime().then(setRuntime);
    }
  }, [runtime]);

  const extensions = useMemo(() => {
    if (!runtime) return null;
    const { EditorView, keymap, placeholder, precHighest, theme } = runtime;
    const dialect = kind === "mysql" ? MySQL : kind === "sqlite" ? SQLite : PostgreSQL;
    const cmSchema = schemas ? buildCmSchema(schemas, kind) : undefined;
    return [
      sql({
        dialect,
        upperCaseKeywords: true,
        ...(cmSchema ? { schema: cmSchema.schema } : {}),
        ...(cmSchema?.defaultSchema ? { defaultSchema: cmSchema.defaultSchema } : {}),
      }),
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
      }),
      search({ top: true }),
      highlightSelectionMatches(),
      placeholder("-- Write your query, then Cmd+Enter to run"),
      theme.cmAppTheme,
      theme.cmHighlightStyle,
      EditorView.theme({
        "&": { height: "100%", fontSize: "13px" },
      }),
    ];
  }, [kind, schemas, onRun, runtime]);

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
        highlightActiveLine: true,
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
