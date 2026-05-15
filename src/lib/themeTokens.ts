export const THEME_TOKENS = [
  "background",
  "foreground",
  "card",
  "card-foreground",
  "popover",
  "popover-foreground",
  "primary",
  "primary-foreground",
  "secondary",
  "secondary-foreground",
  "muted",
  "muted-foreground",
  "accent",
  "accent-foreground",
  "destructive",
  "destructive-foreground",
  "border",
  "input",
  "ring",
  "sidebar",
  "sidebar-foreground",
  "sidebar-border",
  "sidebar-accent",
  "sidebar-accent-foreground",
] as const;

export type ThemeToken = (typeof THEME_TOKENS)[number];
export type ThemeColors = Record<ThemeToken, string>;
export type ThemeBase = "light" | "dark";

export type CustomTheme = {
  id: string;
  name: string;
  base: ThemeBase;
  radius: string;
  colors: ThemeColors;
  created_at: string;
  updated_at: string;
};

export const EXPORT_SCHEMA = "powadb-theme/v1" as const;

export type ExportedTheme = {
  schema: typeof EXPORT_SCHEMA;
  name: string;
  base: ThemeBase;
  radius: string;
  colors: ThemeColors;
};

export const TOKEN_LABELS: Record<ThemeToken, string> = {
  background: "Background",
  foreground: "Foreground",
  card: "Card",
  "card-foreground": "Card foreground",
  popover: "Popover",
  "popover-foreground": "Popover foreground",
  primary: "Primary",
  "primary-foreground": "Primary foreground",
  secondary: "Secondary",
  "secondary-foreground": "Secondary foreground",
  muted: "Muted",
  "muted-foreground": "Muted foreground",
  accent: "Accent",
  "accent-foreground": "Accent foreground",
  destructive: "Destructive",
  "destructive-foreground": "Destructive foreground",
  border: "Border",
  input: "Input",
  ring: "Ring",
  sidebar: "Sidebar",
  "sidebar-foreground": "Sidebar foreground",
  "sidebar-border": "Sidebar border",
  "sidebar-accent": "Sidebar accent",
  "sidebar-accent-foreground": "Sidebar accent foreground",
};

// Mirrors :root in src/index.css (the light preset).
export const LIGHT_PRESET: ThemeColors = {
  background: "oklch(1 0 0)",
  foreground: "oklch(0.145 0 0)",
  card: "oklch(1 0 0)",
  "card-foreground": "oklch(0.145 0 0)",
  popover: "oklch(1 0 0)",
  "popover-foreground": "oklch(0.145 0 0)",
  primary: "oklch(0.6083 0.1728 293.06)",
  "primary-foreground": "oklch(0.985 0 0)",
  secondary: "oklch(0.97 0 0)",
  "secondary-foreground": "oklch(0.205 0 0)",
  muted: "oklch(0.97 0 0)",
  "muted-foreground": "oklch(0.45 0 0)",
  accent: "oklch(0.97 0 0)",
  "accent-foreground": "oklch(0.205 0 0)",
  destructive: "oklch(0.6 0.22 25)",
  "destructive-foreground": "oklch(0.985 0 0)",
  border: "oklch(0.92 0 0)",
  input: "oklch(0.92 0 0)",
  ring: "oklch(0.6083 0.1728 293.06)",
  sidebar: "oklch(0.985 0 0)",
  "sidebar-foreground": "oklch(0.145 0 0)",
  "sidebar-border": "oklch(0.92 0 0)",
  "sidebar-accent": "oklch(0.95 0 0)",
  "sidebar-accent-foreground": "oklch(0.145 0 0)",
};

// Mirrors .dark in src/index.css.
export const DARK_PRESET: ThemeColors = {
  background: "oklch(0.145 0 0)",
  foreground: "oklch(0.985 0 0)",
  card: "oklch(0.18 0 0)",
  "card-foreground": "oklch(0.985 0 0)",
  popover: "oklch(0.18 0 0)",
  "popover-foreground": "oklch(0.985 0 0)",
  primary: "oklch(0.6083 0.1728 293.06)",
  "primary-foreground": "oklch(0.985 0 0)",
  secondary: "oklch(0.24 0 0)",
  "secondary-foreground": "oklch(0.985 0 0)",
  muted: "oklch(0.22 0 0)",
  "muted-foreground": "oklch(0.65 0 0)",
  accent: "oklch(0.24 0 0)",
  "accent-foreground": "oklch(0.985 0 0)",
  destructive: "oklch(0.6 0.22 25)",
  "destructive-foreground": "oklch(0.985 0 0)",
  border: "oklch(0.27 0 0)",
  input: "oklch(0.27 0 0)",
  ring: "oklch(0.6083 0.1728 293.06)",
  sidebar: "oklch(0.16 0 0)",
  "sidebar-foreground": "oklch(0.985 0 0)",
  "sidebar-border": "oklch(0.27 0 0)",
  "sidebar-accent": "oklch(0.22 0 0)",
  "sidebar-accent-foreground": "oklch(0.985 0 0)",
};

export const DEFAULT_RADIUS = "0.5rem";

export function presetColors(base: ThemeBase): ThemeColors {
  return { ...(base === "dark" ? DARK_PRESET : LIGHT_PRESET) };
}

export function toExported(theme: CustomTheme): ExportedTheme {
  return {
    schema: EXPORT_SCHEMA,
    name: theme.name,
    base: theme.base,
    radius: theme.radius,
    colors: { ...theme.colors },
  };
}

export class ThemeImportError extends Error {}

export function fromExported(raw: unknown): ExportedTheme {
  if (!raw || typeof raw !== "object") {
    throw new ThemeImportError("File is not a valid theme object");
  }
  const obj = raw as Record<string, unknown>;
  if (obj.schema !== EXPORT_SCHEMA) {
    throw new ThemeImportError(`Unsupported schema: ${String(obj.schema)}`);
  }
  if (typeof obj.name !== "string" || !obj.name.trim()) {
    throw new ThemeImportError("Theme is missing a name");
  }
  if (obj.base !== "light" && obj.base !== "dark") {
    throw new ThemeImportError("Theme base must be 'light' or 'dark'");
  }
  if (typeof obj.radius !== "string") {
    throw new ThemeImportError("Theme radius must be a string");
  }
  if (!obj.colors || typeof obj.colors !== "object") {
    throw new ThemeImportError("Theme is missing colors");
  }
  const colorsObj = obj.colors as Record<string, unknown>;
  const colors = {} as ThemeColors;
  for (const token of THEME_TOKENS) {
    const v = colorsObj[token];
    if (typeof v !== "string" || !v.trim()) {
      throw new ThemeImportError(`Missing color for "${token}"`);
    }
    colors[token] = v;
  }
  return {
    schema: EXPORT_SCHEMA,
    name: obj.name,
    base: obj.base,
    radius: obj.radius,
    colors,
  };
}

export function colorsToJson(colors: ThemeColors): string {
  return JSON.stringify(colors);
}

export function colorsFromJson(json: string): ThemeColors {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return presetColors("light");
  }
  if (!parsed || typeof parsed !== "object") return presetColors("light");
  const obj = parsed as Record<string, unknown>;
  const colors = {} as ThemeColors;
  const fallback = presetColors("light");
  for (const token of THEME_TOKENS) {
    const v = obj[token];
    colors[token] = typeof v === "string" && v.trim() ? v : fallback[token];
  }
  return colors;
}
