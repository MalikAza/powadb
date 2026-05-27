import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { presetColors, THEME_TOKENS } from "@/lib/themeTokens";
import type { AppSettings, StoredTheme } from "../ipc";

const defaultSettings: AppSettings = {
  pg_dump_path: null,
  mysqldump_path: null,
  psql_path: null,
  mysql_path: null,
  sqlite3_path: null,
  theme_kind: null,
  theme_value: null,
};

const ipcMock = {
  listThemes: vi.fn<() => Promise<StoredTheme[]>>(),
  saveTheme: vi.fn<(input: unknown) => Promise<StoredTheme>>(),
  deleteTheme: vi.fn<(id: string) => Promise<void>>(),
  getSettings: vi.fn<() => Promise<AppSettings>>(),
  saveSettings: vi.fn<(s: AppSettings) => Promise<AppSettings>>(),
};

vi.mock("../ipc", () => ({
  ipc: ipcMock,
}));

const { useTheme, useResolvedTheme, useApplyTheme } = await import("./theme");

function makeStored(over: Partial<StoredTheme> = {}): StoredTheme {
  return {
    id: over.id ?? "custom-1",
    name: over.name ?? "Sunset",
    base: over.base ?? "light",
    radius: over.radius ?? "0.6rem",
    colors_json: over.colors_json ?? JSON.stringify({ primary: "#ff0000" }),
    created_at: over.created_at ?? "2026-01-01T00:00:00Z",
    updated_at: over.updated_at ?? "2026-01-01T00:00:00Z",
  };
}

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
    ipcMock.listThemes.mockReset();
    ipcMock.saveTheme.mockReset();
    ipcMock.deleteTheme.mockReset();
    ipcMock.getSettings.mockReset();
    ipcMock.saveSettings.mockReset();
    ipcMock.getSettings.mockResolvedValue({ ...defaultSettings });
    ipcMock.saveSettings.mockImplementation(async (s) => s);
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

  describe("hydrate", () => {
    it("marks itself hydrated even when no themes or settings exist", async () => {
      ipcMock.listThemes.mockResolvedValue([]);
      await useTheme.getState().hydrate();
      const state = useTheme.getState();
      expect(state.hydrated).toBe(true);
      expect(state.customThemes).toEqual([]);
      expect(state.selection).toEqual({ kind: "preset", mode: "system" });
    });

    it("decodes a stored custom theme and applies fallback colors", async () => {
      ipcMock.listThemes.mockResolvedValue([
        makeStored({ id: "t1", colors_json: JSON.stringify({ primary: "#abcdef" }) }),
      ]);
      await useTheme.getState().hydrate();
      const themes = useTheme.getState().customThemes;
      expect(themes).toHaveLength(1);
      expect(themes[0].id).toBe("t1");
      expect(themes[0].colors.primary).toBe("#abcdef");
      // A token not provided in colors_json falls back to the preset default.
      expect(themes[0].colors.background).toBeTruthy();
    });

    it("falls back to defaults when colors_json is not valid JSON", async () => {
      ipcMock.listThemes.mockResolvedValue([makeStored({ id: "t2", colors_json: "not json" })]);
      await useTheme.getState().hydrate();
      const themes = useTheme.getState().customThemes;
      expect(themes[0].colors.background).toBeTruthy();
      expect(themes[0].colors.primary).toBeTruthy();
    });

    it("falls back to defaults when colors_json has an unexpected shape", async () => {
      ipcMock.listThemes.mockResolvedValue([
        makeStored({ id: "t3", colors_json: JSON.stringify({ primary: 42 }) }),
      ]);
      await useTheme.getState().hydrate();
      const themes = useTheme.getState().customThemes;
      expect(typeof themes[0].colors.primary).toBe("string");
    });

    it("substitutes preset defaults for empty string color values", async () => {
      ipcMock.listThemes.mockResolvedValue([
        makeStored({ id: "t4", colors_json: JSON.stringify({ primary: "   " }) }),
      ]);
      await useTheme.getState().hydrate();
      const themes = useTheme.getState().customThemes;
      expect(themes[0].colors.primary.trim()).not.toBe("");
    });

    it("uses the default radius when stored radius is empty", async () => {
      ipcMock.listThemes.mockResolvedValue([makeStored({ id: "t5", radius: "" })]);
      await useTheme.getState().hydrate();
      const themes = useTheme.getState().customThemes;
      expect(themes[0].radius).toBe("0.5rem");
    });

    it("treats unknown base values as light", async () => {
      ipcMock.listThemes.mockResolvedValue([makeStored({ id: "t6", base: "neon" })]);
      await useTheme.getState().hydrate();
      expect(useTheme.getState().customThemes[0].base).toBe("light");
    });

    it("restores a preset selection from settings", async () => {
      ipcMock.listThemes.mockResolvedValue([]);
      ipcMock.getSettings.mockResolvedValue({
        ...defaultSettings,
        theme_kind: "preset",
        theme_value: "dark",
      });
      await useTheme.getState().hydrate();
      const s = useTheme.getState().selection;
      expect(s).toEqual({ kind: "preset", mode: "dark" });
    });

    it("restores a custom selection when the referenced theme exists", async () => {
      ipcMock.listThemes.mockResolvedValue([makeStored({ id: "t7" })]);
      ipcMock.getSettings.mockResolvedValue({
        ...defaultSettings,
        theme_kind: "custom",
        theme_value: "t7",
      });
      await useTheme.getState().hydrate();
      expect(useTheme.getState().selection).toEqual({ kind: "custom", id: "t7" });
    });

    it("falls back to the default selection when the stored custom id is unknown", async () => {
      ipcMock.listThemes.mockResolvedValue([]);
      ipcMock.getSettings.mockResolvedValue({
        ...defaultSettings,
        theme_kind: "custom",
        theme_value: "ghost",
      });
      await useTheme.getState().hydrate();
      expect(useTheme.getState().selection).toEqual({ kind: "preset", mode: "system" });
    });

    it("falls back to the default selection when the preset value is malformed", async () => {
      ipcMock.listThemes.mockResolvedValue([]);
      ipcMock.getSettings.mockResolvedValue({
        ...defaultSettings,
        theme_kind: "preset",
        theme_value: "neon",
      });
      await useTheme.getState().hydrate();
      expect(useTheme.getState().selection).toEqual({ kind: "preset", mode: "system" });
    });
  });

  describe("setSelection", () => {
    it("persists a preset selection via saveSettings", async () => {
      await useTheme.getState().setSelection({ kind: "preset", mode: "dark" });
      expect(useTheme.getState().selection).toEqual({ kind: "preset", mode: "dark" });
      const lastCall = ipcMock.saveSettings.mock.lastCall;
      expect(lastCall?.[0].theme_kind).toBe("preset");
      expect(lastCall?.[0].theme_value).toBe("dark");
    });

    it("persists a custom selection by id", async () => {
      await useTheme.getState().setSelection({ kind: "custom", id: "abc" });
      const lastCall = ipcMock.saveSettings.mock.lastCall;
      expect(lastCall?.[0].theme_kind).toBe("custom");
      expect(lastCall?.[0].theme_value).toBe("abc");
    });
  });

  describe("upsertCustom", () => {
    it("appends a brand-new theme to the list", async () => {
      ipcMock.saveTheme.mockResolvedValue(makeStored({ id: "new", name: "Fresh" }));
      const result = await useTheme.getState().upsertCustom({
        name: "Fresh",
        base: "light",
        radius: "0.5rem",
        colors: {} as Record<string, string> as never,
      });
      expect(result.id).toBe("new");
      const themes = useTheme.getState().customThemes;
      expect(themes).toHaveLength(1);
      expect(themes[0].name).toBe("Fresh");
    });

    it("replaces the existing entry when id already exists", async () => {
      useTheme.setState({
        customThemes: [
          {
            id: "x",
            name: "Old",
            base: "light",
            radius: "0.5rem",
            colors: {} as never,
            created_at: "",
            updated_at: "",
          },
        ],
      });
      ipcMock.saveTheme.mockResolvedValue(makeStored({ id: "x", name: "New" }));
      await useTheme.getState().upsertCustom({
        id: "x",
        name: "New",
        base: "light",
        radius: "0.5rem",
        colors: {} as never,
      });
      const themes = useTheme.getState().customThemes;
      expect(themes).toHaveLength(1);
      expect(themes[0].name).toBe("New");
    });
  });

  describe("deleteCustom", () => {
    it("removes a non-selected theme without touching settings", async () => {
      useTheme.setState({
        customThemes: [
          {
            id: "keep",
            name: "k",
            base: "light",
            radius: "0.5rem",
            colors: {} as never,
            created_at: "",
            updated_at: "",
          },
          {
            id: "kill",
            name: "x",
            base: "light",
            radius: "0.5rem",
            colors: {} as never,
            created_at: "",
            updated_at: "",
          },
        ],
        selection: { kind: "custom", id: "keep" },
      });
      ipcMock.deleteTheme.mockResolvedValue();
      await useTheme.getState().deleteCustom("kill");
      const state = useTheme.getState();
      expect(state.customThemes.map((t) => t.id)).toEqual(["keep"]);
      expect(state.selection).toEqual({ kind: "custom", id: "keep" });
      expect(ipcMock.saveSettings).not.toHaveBeenCalled();
    });

    it("resets to the default selection when the active custom is deleted", async () => {
      useTheme.setState({
        customThemes: [
          {
            id: "active",
            name: "a",
            base: "dark",
            radius: "0.5rem",
            colors: {} as never,
            created_at: "",
            updated_at: "",
          },
        ],
        selection: { kind: "custom", id: "active" },
      });
      ipcMock.deleteTheme.mockResolvedValue();
      await useTheme.getState().deleteCustom("active");
      const state = useTheme.getState();
      expect(state.customThemes).toEqual([]);
      expect(state.selection).toEqual({ kind: "preset", mode: "system" });
      const lastSaveCall = ipcMock.saveSettings.mock.lastCall;
      expect(lastSaveCall?.[0].theme_kind).toBe("preset");
      expect(lastSaveCall?.[0].theme_value).toBe("system");
    });
  });
});

function makeCustomTheme(over: Partial<{ id: string; base: "light" | "dark" }> = {}) {
  const base = over.base ?? ("dark" as const);
  return {
    id: over.id ?? "c1",
    name: "Custom",
    base,
    radius: "0.5rem",
    colors: presetColors(base),
    created_at: "",
    updated_at: "",
  };
}

describe("useResolvedTheme", () => {
  beforeEach(() => {
    useTheme.setState({
      selection: { kind: "preset", mode: "system" },
      customThemes: [],
      hydrated: false,
    });
    mockMatchMedia(false);
  });

  it("resolves a 'light' preset to 'light'", () => {
    useTheme.setState({ selection: { kind: "preset", mode: "light" } });
    const { result } = renderHook(() => useResolvedTheme());
    expect(result.current).toBe("light");
  });

  it("resolves a 'dark' preset to 'dark'", () => {
    useTheme.setState({ selection: { kind: "preset", mode: "dark" } });
    const { result } = renderHook(() => useResolvedTheme());
    expect(result.current).toBe("dark");
  });

  it("resolves the 'system' preset against matchMedia", () => {
    mockMatchMedia(true);
    useTheme.setState({ selection: { kind: "preset", mode: "system" } });
    const { result } = renderHook(() => useResolvedTheme());
    expect(result.current).toBe("dark");
  });

  it("uses the custom theme's base when a custom selection is active", () => {
    const custom = makeCustomTheme({ id: "x", base: "dark" });
    useTheme.setState({
      customThemes: [custom],
      selection: { kind: "custom", id: "x" },
    });
    const { result } = renderHook(() => useResolvedTheme());
    expect(result.current).toBe("dark");
  });

  it("falls back to 'light' when the custom theme is missing from the list", () => {
    useTheme.setState({ customThemes: [], selection: { kind: "custom", id: "ghost" } });
    const { result } = renderHook(() => useResolvedTheme());
    expect(result.current).toBe("light");
  });
});

describe("useApplyTheme", () => {
  afterEach(() => {
    document.documentElement.classList.remove("dark");
    for (const t of THEME_TOKENS) document.documentElement.style.removeProperty(`--${t}`);
    document.documentElement.style.removeProperty("--radius");
  });

  beforeEach(() => {
    useTheme.setState({
      selection: { kind: "preset", mode: "system" },
      customThemes: [],
      hydrated: false,
    });
    mockMatchMedia(false);
  });

  it("toggles the 'dark' class on the html element when the resolved theme is dark", () => {
    useTheme.setState({ selection: { kind: "preset", mode: "dark" } });
    renderHook(() => useApplyTheme());
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("clears the 'dark' class when the resolved theme is light", () => {
    document.documentElement.classList.add("dark");
    useTheme.setState({ selection: { kind: "preset", mode: "light" } });
    renderHook(() => useApplyTheme());
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("clears inline CSS variables when the selection is a preset", () => {
    document.documentElement.style.setProperty("--background", "red");
    useTheme.setState({ selection: { kind: "preset", mode: "light" } });
    renderHook(() => useApplyTheme());
    expect(document.documentElement.style.getPropertyValue("--background")).toBe("");
  });

  it("applies inline CSS variables for the active custom theme", () => {
    const custom = makeCustomTheme({ id: "abc", base: "dark" });
    useTheme.setState({
      customThemes: [custom],
      selection: { kind: "custom", id: "abc" },
    });
    renderHook(() => useApplyTheme());
    expect(document.documentElement.style.getPropertyValue("--background")).toBe(
      custom.colors.background,
    );
    expect(document.documentElement.style.getPropertyValue("--radius")).toBe("0.5rem");
  });

  it("clears inline vars when the active custom id is missing from the list", () => {
    document.documentElement.style.setProperty("--background", "#abcdef");
    useTheme.setState({ customThemes: [], selection: { kind: "custom", id: "ghost" } });
    renderHook(() => useApplyTheme());
    expect(document.documentElement.style.getPropertyValue("--background")).toBe("");
  });

  it("removes inline vars on unmount of a custom theme", () => {
    const custom = makeCustomTheme({ id: "u1", base: "light" });
    useTheme.setState({
      customThemes: [custom],
      selection: { kind: "custom", id: "u1" },
    });
    const { unmount } = renderHook(() => useApplyTheme());
    expect(document.documentElement.style.getPropertyValue("--background")).toBe(
      custom.colors.background,
    );
    act(() => unmount());
    expect(document.documentElement.style.getPropertyValue("--background")).toBe("");
  });
});
