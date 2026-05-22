// Shared CodeMirror runtime loader for the lazy editor chunks.
//
// Both SqlEditor and MongoEditor are `React.lazy`'d, and CodeMirror's
// `@codemirror/view` / `@codemirror/state` packages weigh enough that we
// don't want to load them in the initial bundle. This module owns the
// dynamic import + a module-level cache so the second editor type to mount
// reuses what the first one loaded.

import { type EditorThemeBundle, loadEditorTheme } from "./editorTheme";

type PrecHighest = <T>(ext: T) => T;
export type CmRuntime = {
  EditorView: typeof import("@codemirror/view").EditorView;
  Decoration: typeof import("@codemirror/view").Decoration;
  ViewPlugin: typeof import("@codemirror/view").ViewPlugin;
  keymap: typeof import("@codemirror/view").keymap;
  placeholder: typeof import("@codemirror/view").placeholder;
  precHighest: PrecHighest;
  theme: EditorThemeBundle;
};

let cachedRuntime: CmRuntime | null = null;

export function getCachedCmRuntime(): CmRuntime | null {
  return cachedRuntime;
}

export function loadCmRuntime(): Promise<CmRuntime> {
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
/// selection. The built-in `highlightActiveLine` always paints the line
/// decoration, which overlays the selection layer on the cursor's line
/// (giving that one line a different appearance than the rest of a
/// multi-line selection). This variant only decorates when the main
/// selection is a bare cursor.
export function selectionAwareActiveLine(runtime: CmRuntime) {
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
