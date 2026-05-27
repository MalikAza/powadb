import { describe, expect, it } from "vitest";
import { COMMUNITY_THEMES } from "./communityThemes";

describe("COMMUNITY_THEMES", () => {
  it("loads at least one bundled theme", () => {
    expect(COMMUNITY_THEMES.length).toBeGreaterThan(0);
  });

  it("each entry has a slug and a fully-shaped ExportedTheme", () => {
    for (const c of COMMUNITY_THEMES) {
      expect(c.slug).toMatch(/^[a-z0-9][a-z0-9-]*$/i);
      expect(typeof c.theme.name).toBe("string");
      expect(c.theme.name.length).toBeGreaterThan(0);
      expect(["light", "dark"]).toContain(c.theme.base);
      expect(c.theme.colors).toBeTypeOf("object");
      // A few tokens that every palette is required to ship.
      expect(typeof c.theme.colors.primary).toBe("string");
      expect(typeof c.theme.colors.background).toBe("string");
      expect(typeof c.theme.colors.accent).toBe("string");
      expect(typeof c.theme.colors.border).toBe("string");
    }
  });

  it("slugs are unique", () => {
    const slugs = COMMUNITY_THEMES.map((c) => c.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("themes are sorted by display name", () => {
    const names = COMMUNITY_THEMES.map((c) => c.theme.name);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    expect(names).toEqual(sorted);
  });
});
