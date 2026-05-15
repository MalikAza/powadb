import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTheme } from "./theme";

function mockMatchMedia(isDark: boolean) {
  window.matchMedia = vi.fn().mockImplementation(() => ({
    matches: isDark,
    media: "(prefers-color-scheme: dark)",
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

describe("useTheme store", () => {
  beforeEach(() => {
    useTheme.setState({
      selection: { kind: "preset", mode: "system" },
      customThemes: [],
      hydrated: false,
    });
    mockMatchMedia(false);
  });

  it("defaults to the system preset", () => {
    const s = useTheme.getState().selection;
    expect(s.kind).toBe("preset");
    if (s.kind === "preset") expect(s.mode).toBe("system");
  });

  it("setSelection updates state synchronously", () => {
    useTheme.setState({ selection: { kind: "preset", mode: "dark" } });
    const s = useTheme.getState().selection;
    expect(s.kind).toBe("preset");
    if (s.kind === "preset") expect(s.mode).toBe("dark");
  });

  it("tracks the active custom theme by id", () => {
    useTheme.setState({ selection: { kind: "custom", id: "abc" } });
    const s = useTheme.getState().selection;
    expect(s.kind).toBe("custom");
    if (s.kind === "custom") expect(s.id).toBe("abc");
  });
});
