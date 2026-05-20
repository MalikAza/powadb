import { useEffect, useState } from "react";
import { create } from "zustand";
import { ipc, type StoredTheme } from "@/ipc";
import { themeColorsJsonSchema } from "@/lib/schemas";
import {
  type CustomTheme,
  DEFAULT_RADIUS,
  presetColors,
  THEME_TOKENS,
  type ThemeBase,
  type ThemeColors,
} from "@/lib/themeTokens";

export type ThemeMode = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export type ThemeSelection = { kind: "preset"; mode: ThemeMode } | { kind: "custom"; id: string };

type State = {
  selection: ThemeSelection;
  customThemes: CustomTheme[];
  hydrated: boolean;
};

type Actions = {
  setSelection: (s: ThemeSelection) => Promise<void>;
  upsertCustom: (
    input: Omit<CustomTheme, "id" | "created_at" | "updated_at"> & { id?: string },
  ) => Promise<CustomTheme>;
  deleteCustom: (id: string) => Promise<void>;
  hydrate: () => Promise<void>;
};

const DEFAULT_SELECTION: ThemeSelection = { kind: "preset", mode: "system" };

function parseColorsJson(raw: string, themeId: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.warn(`Theme ${themeId}: colors_json is invalid JSON, falling back to defaults`, e);
    return {};
  }
  const result = themeColorsJsonSchema.safeParse(parsed);
  if (!result.success) {
    console.warn(
      `Theme ${themeId}: colors_json has unexpected shape, falling back to defaults`,
      result.error.issues,
    );
    return {};
  }
  return result.data;
}

function decodeStored(t: StoredTheme): CustomTheme {
  const base: ThemeBase = t.base === "dark" ? "dark" : "light";
  const parsedColors = parseColorsJson(t.colors_json, t.id);
  const fallback = presetColors(base);
  const colors = {} as ThemeColors;
  for (const token of THEME_TOKENS) {
    const v = parsedColors[token];
    colors[token] = v?.trim() ? v : fallback[token];
  }
  return {
    id: t.id,
    name: t.name,
    base,
    radius: t.radius || DEFAULT_RADIUS,
    colors,
    created_at: t.created_at,
    updated_at: t.updated_at,
  };
}

function selectionFromSettings(
  kind: string | null,
  value: string | null,
  themes: CustomTheme[],
): ThemeSelection {
  if (kind === "custom" && value && themes.some((t) => t.id === value)) {
    return { kind: "custom", id: value };
  }
  if (kind === "preset" && (value === "light" || value === "dark" || value === "system")) {
    return { kind: "preset", mode: value };
  }
  return DEFAULT_SELECTION;
}

function selectionToSettings(s: ThemeSelection): { kind: string; value: string } {
  return s.kind === "preset" ? { kind: "preset", value: s.mode } : { kind: "custom", value: s.id };
}

async function persistSelection(s: ThemeSelection): Promise<void> {
  const current = await ipc.getSettings();
  const { kind, value } = selectionToSettings(s);
  await ipc.saveSettings({ ...current, theme_kind: kind, theme_value: value });
}

export const useTheme = create<State & Actions>()((set, get) => ({
  selection: DEFAULT_SELECTION,
  customThemes: [],
  hydrated: false,

  hydrate: async () => {
    const [stored, settings] = await Promise.all([ipc.listThemes(), ipc.getSettings()]);
    const customThemes = stored.map(decodeStored);
    const selection = selectionFromSettings(
      settings.theme_kind,
      settings.theme_value,
      customThemes,
    );
    set({ customThemes, selection, hydrated: true });
  },

  setSelection: async (s) => {
    set({ selection: s });
    await persistSelection(s);
  },

  upsertCustom: async (input) => {
    const saved = await ipc.saveTheme({
      id: input.id,
      name: input.name,
      base: input.base,
      radius: input.radius,
      colors_json: JSON.stringify(input.colors),
    });
    const theme = decodeStored(saved);
    set((state) => {
      const exists = state.customThemes.some((t) => t.id === theme.id);
      const customThemes = exists
        ? state.customThemes.map((t) => (t.id === theme.id ? theme : t))
        : [...state.customThemes, theme];
      return { customThemes };
    });
    return theme;
  },

  deleteCustom: async (id) => {
    await ipc.deleteTheme(id);
    const { selection } = get();
    const next: Partial<State> = {
      customThemes: get().customThemes.filter((t) => t.id !== id),
    };
    if (selection.kind === "custom" && selection.id === id) {
      next.selection = DEFAULT_SELECTION;
      await persistSelection(DEFAULT_SELECTION);
    }
    set(next);
  },
}));

function resolvePreset(mode: ThemeMode): ResolvedTheme {
  if (mode !== "system") return mode;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function useResolvedTheme(): ResolvedTheme {
  const selection = useTheme((s) => s.selection);
  const customThemes = useTheme((s) => s.customThemes);

  const initial: ResolvedTheme =
    selection.kind === "preset"
      ? resolvePreset(selection.mode)
      : (customThemes.find((t) => t.id === selection.id)?.base ?? "light");

  const [resolved, setResolved] = useState<ResolvedTheme>(initial);

  useEffect(() => {
    if (selection.kind === "custom") {
      const custom = customThemes.find((t) => t.id === selection.id);
      setResolved(custom?.base ?? "light");
      return;
    }
    const computeFromPreset = () => setResolved(resolvePreset(selection.mode));
    computeFromPreset();
    if (selection.mode !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", computeFromPreset);
    return () => mq.removeEventListener("change", computeFromPreset);
  }, [selection, customThemes]);

  return resolved;
}

export function useApplyTheme() {
  const selection = useTheme((s) => s.selection);
  const customThemes = useTheme((s) => s.customThemes);
  const resolved = useResolvedTheme();

  useEffect(() => {
    document.documentElement.classList.toggle("dark", resolved === "dark");
  }, [resolved]);

  useEffect(() => {
    const root = document.documentElement;
    const clearInline = () => {
      for (const token of THEME_TOKENS) {
        root.style.removeProperty(`--${token}`);
      }
      root.style.removeProperty("--radius");
    };

    if (selection.kind !== "custom") {
      clearInline();
      return;
    }
    const custom = customThemes.find((t) => t.id === selection.id);
    if (!custom) {
      clearInline();
      return;
    }
    for (const token of THEME_TOKENS) {
      root.style.setProperty(`--${token}`, custom.colors[token]);
    }
    root.style.setProperty("--radius", custom.radius);
    return clearInline;
  }, [selection, customThemes]);
}
