import { describe, expect, it } from "vitest";
import {
  type CustomTheme,
  colorsFromJson,
  colorsToJson,
  DARK_PRESET,
  EXPORT_SCHEMA,
  fromExported,
  LIGHT_PRESET,
  presetColors,
  THEME_TOKENS,
  ThemeImportError,
  toExported,
} from "./themeTokens";

function makeTheme(overrides: Partial<CustomTheme> = {}): CustomTheme {
  return {
    id: "id-1",
    name: "Sample",
    base: "light",
    radius: "0.5rem",
    colors: { ...LIGHT_PRESET },
    created_at: "2026-01-01",
    updated_at: "2026-01-02",
    ...overrides,
  };
}

describe("toExported / fromExported", () => {
  it("round-trips a light theme without losing data", () => {
    const original = makeTheme();
    const exported = toExported(original);
    const parsed = fromExported(JSON.parse(JSON.stringify(exported)));
    expect(parsed.schema).toBe(EXPORT_SCHEMA);
    expect(parsed.name).toBe(original.name);
    expect(parsed.base).toBe("light");
    expect(parsed.radius).toBe(original.radius);
    for (const token of THEME_TOKENS) {
      expect(parsed.colors[token]).toBe(original.colors[token]);
    }
  });

  it("round-trips a dark theme", () => {
    const original = makeTheme({ base: "dark", colors: { ...DARK_PRESET } });
    const parsed = fromExported(JSON.parse(JSON.stringify(toExported(original))));
    expect(parsed.base).toBe("dark");
    for (const token of THEME_TOKENS) {
      expect(parsed.colors[token]).toBe(DARK_PRESET[token]);
    }
  });

  it("does not include id or timestamps in the exported payload", () => {
    const exported = toExported(makeTheme());
    expect(exported).not.toHaveProperty("id");
    expect(exported).not.toHaveProperty("created_at");
    expect(exported).not.toHaveProperty("updated_at");
  });
});

describe("fromExported validation", () => {
  it("rejects a non-object input", () => {
    expect(() => fromExported(null)).toThrow(ThemeImportError);
    expect(() => fromExported("hello")).toThrow(ThemeImportError);
  });

  it("rejects a wrong schema tag", () => {
    const bad = { ...toExported(makeTheme()), schema: "powadb-theme/v999" };
    expect(() => fromExported(bad)).toThrow(/Unsupported schema/);
  });

  it("rejects an empty name", () => {
    const bad = { ...toExported(makeTheme()), name: "  " };
    expect(() => fromExported(bad)).toThrow(/name/i);
  });

  it("rejects an invalid base", () => {
    const bad = { ...toExported(makeTheme()), base: "neon" };
    expect(() => fromExported(bad)).toThrow(/base/i);
  });

  it("rejects when a color token is missing", () => {
    const exported = toExported(makeTheme()) as unknown as {
      colors: Record<string, string>;
    };
    const colors = { ...exported.colors };
    delete colors.primary;
    const bad = { ...exported, colors };
    expect(() => fromExported(bad)).toThrow(/primary/);
  });

  it("rejects when a color token is not a string", () => {
    const exported = toExported(makeTheme()) as unknown as {
      colors: Record<string, unknown>;
    };
    const bad = { ...exported, colors: { ...exported.colors, primary: 42 } };
    expect(() => fromExported(bad)).toThrow(/primary/);
  });

  it("rejects when radius is not a string", () => {
    const bad = { ...toExported(makeTheme()), radius: 0.5 };
    expect(() => fromExported(bad)).toThrow(/radius/i);
  });

  it("rejects when colors is missing entirely", () => {
    const exported = toExported(makeTheme()) as unknown as Record<string, unknown>;
    const { colors: _omit, ...rest } = exported;
    expect(() => fromExported(rest)).toThrow(/colors/i);
  });

  it("rejects when a color token is an empty/whitespace string", () => {
    const exported = toExported(makeTheme()) as unknown as {
      colors: Record<string, unknown>;
    };
    const bad = { ...exported, colors: { ...exported.colors, primary: "   " } };
    expect(() => fromExported(bad)).toThrow(/primary/);
  });
});

describe("presetColors", () => {
  it("returns a fresh copy of LIGHT_PRESET for 'light'", () => {
    const c = presetColors("light");
    expect(c).toEqual(LIGHT_PRESET);
    expect(c).not.toBe(LIGHT_PRESET);
  });

  it("returns a fresh copy of DARK_PRESET for 'dark'", () => {
    const c = presetColors("dark");
    expect(c).toEqual(DARK_PRESET);
    expect(c).not.toBe(DARK_PRESET);
  });
});

describe("colorsToJson / colorsFromJson", () => {
  it("round-trips colors via JSON", () => {
    const json = colorsToJson(LIGHT_PRESET);
    const parsed = colorsFromJson(json);
    expect(parsed).toEqual(LIGHT_PRESET);
  });

  it("falls back to the light preset on invalid JSON", () => {
    expect(colorsFromJson("not-json")).toEqual(LIGHT_PRESET);
  });

  it("falls back to the light preset when JSON is not an object", () => {
    expect(colorsFromJson("42")).toEqual(LIGHT_PRESET);
    expect(colorsFromJson("null")).toEqual(LIGHT_PRESET);
  });

  it("fills missing tokens with the light preset", () => {
    const json = JSON.stringify({ primary: "oklch(0.5 0 0)" });
    const parsed = colorsFromJson(json);
    expect(parsed.primary).toBe("oklch(0.5 0 0)");
    expect(parsed.background).toBe(LIGHT_PRESET.background);
  });

  it("ignores non-string and whitespace-only values", () => {
    const json = JSON.stringify({ primary: 42, background: "   " });
    const parsed = colorsFromJson(json);
    expect(parsed.primary).toBe(LIGHT_PRESET.primary);
    expect(parsed.background).toBe(LIGHT_PRESET.background);
  });
});
