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
  Decoration: typeof import("@codemirror/view").Decoration;
  ViewPlugin: typeof import("@codemirror/view").ViewPlugin;
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
    const rt: CmRuntime = {
      EditorView: view.EditorView,
      Decoration: view.Decoration,
      ViewPlugin: view.ViewPlugin,
      keymap: view.keymap,
      placeholder: view.placeholder,
      precHighest: state.Prec.highest as PrecHighest,
      theme,
    };
    cachedRuntime = rt;
    return rt;
  });
}

/// Active-line highlight that suppresses itself when there's a non-empty
/// selection. The built-in `highlightActiveLine` always adds the line
/// decoration, which paints over the selection layer on the line containing
/// the cursor (giving that one line a different appearance than the rest of
/// a multi-line selection). This variant only decorates the line when the
/// main selection is a bare cursor.
function selectionAwareActiveLine(runtime: CmRuntime) {
  const { Decoration, ViewPlugin } = runtime;
  const lineDeco = Decoration.line({ attributes: { class: "cm-activeLine" } });
  type View = import("@codemirror/view").EditorView;
  type ViewUpdate = import("@codemirror/view").ViewUpdate;
  type DecorationSet = import("@codemirror/view").DecorationSet;

  function compute(view: View): DecorationSet {
    const sel = view.state.selection.main;
    if (sel.from !== sel.to) return Decoration.none;
    const line = view.state.doc.lineAt(sel.head);
    return Decoration.set([lineDeco.range(line.from)]);
  }

  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: View) {
        this.decorations = compute(view);
      }
      update(update: ViewUpdate) {
        if (update.docChanged || update.selectionSet) {
          this.decorations = compute(update.view);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );
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
      selectionAwareActiveLine(runtime),
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
        // Disabled in favor of our `selectionAwareActiveLine` extension,
        // which suppresses the line decoration during non-empty selections.
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
