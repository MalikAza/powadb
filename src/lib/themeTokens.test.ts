import { describe, expect, it } from "vitest";
import {
  type CustomTheme,
  DARK_PRESET,
  EXPORT_SCHEMA,
  fromExported,
  LIGHT_PRESET,
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
});
