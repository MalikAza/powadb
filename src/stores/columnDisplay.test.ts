import { beforeEach, describe, expect, it } from "vitest";
import { columnDisplayKey, useColumnDisplay } from "./columnDisplay";

function reset() {
  useColumnDisplay.setState({ byteaModes: {}, columnWidths: {} });
}

describe("columnDisplayKey", () => {
  it("joins identifiers with colons", () => {
    expect(columnDisplayKey("c1", "public", "users", "id")).toBe("c1:public:users:id");
  });
});

describe("useColumnDisplay", () => {
  beforeEach(reset);

  it("starts with an empty map", () => {
    expect(useColumnDisplay.getState().byteaModes).toEqual({});
  });

  it("setByteaMode stores the mode under the given key", () => {
    const key = columnDisplayKey("c1", "public", "users", "id");
    useColumnDisplay.getState().setByteaMode(key, "ulid");
    expect(useColumnDisplay.getState().byteaModes[key]).toBe("ulid");
  });

  it("setByteaMode overwrites without dropping siblings", () => {
    const a = columnDisplayKey("c1", "public", "users", "id");
    const b = columnDisplayKey("c1", "public", "orders", "uid");
    useColumnDisplay.getState().setByteaMode(a, "ulid");
    useColumnDisplay.getState().setByteaMode(b, "uuid");
    useColumnDisplay.getState().setByteaMode(a, "hex");
    const modes = useColumnDisplay.getState().byteaModes;
    expect(modes[a]).toBe("hex");
    expect(modes[b]).toBe("uuid");
  });

  it("setColumnWidth stores the width under the given key", () => {
    const key = columnDisplayKey("c1", "public", "users", "id");
    useColumnDisplay.getState().setColumnWidth(key, 240);
    expect(useColumnDisplay.getState().columnWidths[key]).toBe(240);
  });

  it("setColumnWidth overwrites without dropping siblings", () => {
    const a = columnDisplayKey("c1", "public", "users", "id");
    const b = columnDisplayKey("c1", "public", "orders", "uid");
    useColumnDisplay.getState().setColumnWidth(a, 100);
    useColumnDisplay.getState().setColumnWidth(b, 200);
    useColumnDisplay.getState().setColumnWidth(a, 150);
    const widths = useColumnDisplay.getState().columnWidths;
    expect(widths[a]).toBe(150);
    expect(widths[b]).toBe(200);
  });

  it("clearColumnWidth removes only the targeted entry", () => {
    const a = columnDisplayKey("c1", "public", "users", "id");
    const b = columnDisplayKey("c1", "public", "orders", "uid");
    useColumnDisplay.getState().setColumnWidth(a, 100);
    useColumnDisplay.getState().setColumnWidth(b, 200);
    useColumnDisplay.getState().clearColumnWidth(a);
    const widths = useColumnDisplay.getState().columnWidths;
    expect(widths[a]).toBeUndefined();
    expect(widths[b]).toBe(200);
  });

  it("clearColumnWidth is a no-op when the key is absent", () => {
    const before = useColumnDisplay.getState();
    useColumnDisplay.getState().clearColumnWidth("missing");
    const after = useColumnDisplay.getState();
    // Zustand should keep the same state reference when the action returns it unchanged.
    expect(after.columnWidths).toBe(before.columnWidths);
  });
});
