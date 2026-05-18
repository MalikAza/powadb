import { beforeEach, describe, expect, it } from "vitest";
import { columnDisplayKey, useColumnDisplay } from "./columnDisplay";

function reset() {
  useColumnDisplay.setState({ byteaModes: {} });
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
});
