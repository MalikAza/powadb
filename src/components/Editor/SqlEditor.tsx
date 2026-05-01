import { useMemo } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { sql, PostgreSQL, MySQL } from "@codemirror/lang-sql";
import { keymap, EditorView } from "@codemirror/view";
import { useConnections } from "../../stores/connections";
import { buildCmSchema, useSchema } from "../../stores/schema";
import type { DbKind } from "../../types";

type Props = {
  value: string;
  onChange: (next: string) => void;
  onRun: () => void;
  kind: DbKind;
};

export function SqlEditor({ value, onChange, onRun, kind }: Props) {
  const activeId = useConnections((s) => s.activeId);
  const schemas = useSchema((s) => (activeId ? s.byConnection[activeId] : undefined));

  const extensions = useMemo(() => {
    const dialect = kind === "mysql" ? MySQL : PostgreSQL;
    const cmSchema = schemas ? buildCmSchema(schemas, kind) : undefined;
    return [
      sql({
        dialect,
        upperCaseKeywords: true,
        ...(cmSchema ? { schema: cmSchema.schema } : {}),
        ...(cmSchema?.defaultSchema ? { defaultSchema: cmSchema.defaultSchema } : {}),
      }),
      keymap.of([
        {
          key: "Mod-Enter",
          preventDefault: true,
          run: () => {
            onRun();
            return true;
          },
        },
      ]),
      EditorView.theme({
        "&": { height: "100%", fontSize: "13px" },
        ".cm-scroller": { fontFamily: "ui-monospace, monospace" },
      }),
    ];
  }, [kind, schemas, onRun]);

  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      theme="dark"
      height="100%"
      extensions={extensions}
      basicSetup={{
        lineNumbers: true,
        highlightActiveLine: true,
        highlightSelectionMatches: true,
        bracketMatching: true,
        closeBrackets: true,
        autocompletion: true,
      }}
      style={{ flex: 1, minHeight: 0, overflow: "hidden" }}
    />
  );
}
