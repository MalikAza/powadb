import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

// The @codemirror/view package is shipped as a separate chunk via the
// dynamic `import()` below, so consumers awaiting `loadEditorTheme()` only
// pull CodeMirror's view layer on first use.

const selectionBg = "color-mix(in oklch, var(--primary) 30%, transparent)";
const searchMatchBg = "color-mix(in oklch, var(--primary) 25%, transparent)";
const searchMatchSelectedBg = "color-mix(in oklch, var(--primary) 50%, transparent)";
const selectionMatchBg = "color-mix(in oklch, var(--ring) 20%, transparent)";
const stringColor = "color-mix(in oklch, var(--primary) 45%, var(--foreground))";

const themeSpec = {
  "&": {
    backgroundColor: "var(--background)",
    color: "var(--foreground)",
  },
  ".cm-content": {
    caretColor: "var(--foreground)",
    fontFamily: "var(--font-mono)",
  },
  ".cm-scroller": {
    fontFamily: "var(--font-mono)",
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--foreground)",
  },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: selectionBg,
  },
  ".cm-gutters": {
    backgroundColor: "var(--card)",
    color: "var(--muted-foreground)",
    borderRight: "1px solid var(--border)",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "var(--accent)",
    color: "var(--accent-foreground)",
  },
  ".cm-activeLine": {
    backgroundColor: "var(--accent)",
  },
  ".cm-foldPlaceholder": {
    backgroundColor: "var(--muted)",
    color: "var(--muted-foreground)",
    border: "1px solid var(--border)",
  },
  ".cm-tooltip": {
    backgroundColor: "var(--popover)",
    color: "var(--popover-foreground)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-md)",
    boxShadow: "0 4px 12px rgb(0 0 0 / 0.15)",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul": {
    fontFamily: "var(--font-mono)",
    maxHeight: "16em",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li": {
    padding: "2px 8px",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": {
    backgroundColor: "var(--accent)",
    color: "var(--accent-foreground)",
  },
  ".cm-completionLabel": {
    color: "var(--foreground)",
  },
  ".cm-completionDetail": {
    color: "var(--muted-foreground)",
    fontStyle: "normal",
    marginLeft: "0.75em",
  },
  ".cm-completionMatchedText": {
    color: "var(--primary)",
    textDecoration: "none",
    fontWeight: "600",
  },
  ".cm-panels": {
    backgroundColor: "var(--card)",
    color: "var(--foreground)",
  },
  ".cm-panels.cm-panels-top": {
    borderBottom: "1px solid var(--border)",
  },
  ".cm-panels.cm-panels-bottom": {
    borderTop: "1px solid var(--border)",
  },
  ".cm-panel": {
    padding: "4px 8px",
  },
  ".cm-panel input, .cm-panel button, .cm-panel label": {
    fontFamily: "var(--font-sans)",
    fontSize: "12px",
  },
  ".cm-panel input[type=checkbox]": {
    accentColor: "var(--primary)",
  },
  ".cm-panel input[type=text], .cm-textfield": {
    backgroundColor: "var(--background)",
    color: "var(--foreground)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-sm)",
    padding: "2px 6px",
  },
  ".cm-button": {
    backgroundColor: "var(--secondary)",
    color: "var(--secondary-foreground)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-sm)",
    backgroundImage: "none",
    padding: "2px 8px",
  },
  ".cm-button:hover": {
    backgroundColor: "var(--accent)",
  },
  ".cm-searchMatch": {
    backgroundColor: searchMatchBg,
    outline: "1px solid color-mix(in oklch, var(--primary) 60%, transparent)",
  },
  ".cm-searchMatch.cm-searchMatch-selected": {
    backgroundColor: searchMatchSelectedBg,
  },
  ".cm-selectionMatch": {
    backgroundColor: selectionMatchBg,
  },
  ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
    backgroundColor: "transparent",
    outline: "1px solid var(--ring)",
  },
  ".cm-nonmatchingBracket": {
    color: "var(--destructive)",
  },
  ".cm-placeholder": {
    color: "var(--muted-foreground)",
    fontStyle: "italic",
  },
  ".cm-lineNumbers .cm-gutterElement": {
    minWidth: "2.5em",
    padding: "0 6px 0 4px",
  },
};

const highlightStyle = HighlightStyle.define([
  {
    tag: [t.keyword, t.controlKeyword, t.operatorKeyword],
    color: "var(--primary)",
    fontWeight: "600",
  },
  { tag: [t.atom, t.bool, t.null, t.number], color: "var(--ring)" },
  { tag: [t.string, t.special(t.string), t.regexp], color: stringColor },
  {
    tag: [t.comment, t.lineComment, t.blockComment, t.docComment],
    color: "var(--muted-foreground)",
    fontStyle: "italic",
  },
  { tag: [t.variableName, t.propertyName], color: "var(--foreground)" },
  { tag: [t.typeName, t.className], color: "var(--ring)" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "var(--foreground)" },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket], color: "var(--muted-foreground)" },
  { tag: t.invalid, color: "var(--destructive)" },
]);

const cmHighlightStyle = syntaxHighlighting(highlightStyle);

export type EditorThemeBundle = {
  cmAppTheme: import("@codemirror/state").Extension;
  cmHighlightStyle: import("@codemirror/state").Extension;
};

let cached: EditorThemeBundle | null = null;

export function loadEditorTheme(): Promise<EditorThemeBundle> {
  if (cached) return Promise.resolve(cached);
  return import("@codemirror/view").then((m) => {
    cached = {
      cmAppTheme: m.EditorView.theme(themeSpec),
      cmHighlightStyle,
    };
    return cached;
  });
}
