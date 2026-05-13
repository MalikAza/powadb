import { beforeEach, describe, expect, it } from "vitest";
import { useUi } from "./ui";

function reset() {
  useUi.setState({
    pane: "schema",
    openSchemas: {},
    openTables: {},
    exportDialog: null,
    importDialog: null,
    schemaSearchFocusToken: 0,
  });
}

describe("useUi", () => {
  beforeEach(reset);

  it("starts on the schema pane with nothing expanded", () => {
    const s = useUi.getState();
    expect(s.pane).toBe("schema");
    expect(s.openSchemas).toEqual({});
    expect(s.openTables).toEqual({});
  });

  it("setPane switches between sidebar panes", () => {
    useUi.getState().setPane("history");
    expect(useUi.getState().pane).toBe("history");
    useUi.getState().setPane("snippets");
    expect(useUi.getState().pane).toBe("snippets");
  });

  it("toggleSchema flips open state and starts from closed", () => {
    useUi.getState().toggleSchema("public");
    expect(useUi.getState().openSchemas.public).toBe(true);
    useUi.getState().toggleSchema("public");
    expect(useUi.getState().openSchemas.public).toBe(false);
  });

  it("setSchemaOpen forces an explicit state", () => {
    useUi.getState().setSchemaOpen("public", true);
    expect(useUi.getState().openSchemas.public).toBe(true);
    useUi.getState().setSchemaOpen("public", false);
    expect(useUi.getState().openSchemas.public).toBe(false);
  });

  it("toggleTable keys on schema.table and is independent across schemas", () => {
    useUi.getState().toggleTable("public", "users");
    useUi.getState().toggleTable("auth", "users");
    expect(useUi.getState().openTables["public.users"]).toBe(true);
    expect(useUi.getState().openTables["auth.users"]).toBe(true);
    useUi.getState().toggleTable("public", "users");
    expect(useUi.getState().openTables["public.users"]).toBe(false);
    expect(useUi.getState().openTables["auth.users"]).toBe(true);
  });

  it("setTableOpen forces explicit state for a given table", () => {
    useUi.getState().setTableOpen("public", "users", true);
    expect(useUi.getState().openTables["public.users"]).toBe(true);
    useUi.getState().setTableOpen("public", "users", false);
    expect(useUi.getState().openTables["public.users"]).toBe(false);
  });

  it("revealTable switches to schema pane and opens the schema + table", () => {
    useUi.getState().setPane("history");
    useUi.getState().revealTable("public", "orders");
    const s = useUi.getState();
    expect(s.pane).toBe("schema");
    expect(s.openSchemas.public).toBe(true);
    expect(s.openTables["public.orders"]).toBe(true);
  });

  it("openExportDialog stores the connection id and closeExportDialog clears it", () => {
    useUi.getState().openExportDialog("c1");
    expect(useUi.getState().exportDialog).toEqual({ connectionId: "c1" });
    useUi.getState().closeExportDialog();
    expect(useUi.getState().exportDialog).toBeNull();
  });

  it("openImportDialog / closeImportDialog work the same way", () => {
    useUi.getState().openImportDialog("c1");
    expect(useUi.getState().importDialog).toEqual({ connectionId: "c1" });
    useUi.getState().closeImportDialog();
    expect(useUi.getState().importDialog).toBeNull();
  });

  it("focusSchemaSearch moves to schema pane and bumps the focus token", () => {
    useUi.getState().setPane("history");
    const before = useUi.getState().schemaSearchFocusToken;
    useUi.getState().focusSchemaSearch();
    const after = useUi.getState();
    expect(after.pane).toBe("schema");
    expect(after.schemaSearchFocusToken).toBe(before + 1);
  });
});
