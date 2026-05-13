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
    useTheme.setState({ mode: "system" });
    mockMatchMedia(false);
  });

  it("defaults to system", () => {
    expect(useTheme.getState().mode).toBe("system");
  });

  it("setMode updates the stored mode", () => {
    useTheme.getState().setMode("dark");
    expect(useTheme.getState().mode).toBe("dark");
    useTheme.getState().setMode("light");
    expect(useTheme.getState().mode).toBe("light");
    useTheme.getState().setMode("system");
    expect(useTheme.getState().mode).toBe("system");
  });
});
