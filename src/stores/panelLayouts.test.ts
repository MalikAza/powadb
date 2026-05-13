import { beforeEach, describe, expect, it } from "vitest";
import { usePanelLayouts } from "./panelLayouts";

describe("usePanelLayouts", () => {
  beforeEach(() => {
    usePanelLayouts.setState({ layouts: {} });
  });

  it("setLayout stores the layout under the given id", () => {
    usePanelLayouts.getState().setLayout("editor", { left: 60, right: 40 });
    expect(usePanelLayouts.getState().layouts.editor).toEqual({ left: 60, right: 40 });
  });

  it("setLayout replaces an existing layout without touching other ids", () => {
    usePanelLayouts.getState().setLayout("editor", { left: 60, right: 40 });
    usePanelLayouts.getState().setLayout("sidebar", { a: 25, b: 75 });
    usePanelLayouts.getState().setLayout("editor", { left: 50, right: 50 });
    const { layouts } = usePanelLayouts.getState();
    expect(layouts.editor).toEqual({ left: 50, right: 50 });
    expect(layouts.sidebar).toEqual({ a: 25, b: 75 });
  });
});
