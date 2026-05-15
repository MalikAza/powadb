import { type ExportedTheme, fromExported, ThemeImportError } from "@/lib/themeTokens";

// Vite bundles every *.powadb-theme.json from /themes at build time. Each is
// validated through the same fromExported() guard the import button uses, so a
// malformed file fails CI (via scripts/validate-themes.mjs) and is also skipped
// here defensively.
const modules = import.meta.glob<unknown>("../../themes/*.powadb-theme.json", {
  eager: true,
  import: "default",
});

export type CommunityTheme = {
  /** Stable identifier derived from the filename (e.g. "nord"). */
  slug: string;
  theme: ExportedTheme;
};

function slugFromPath(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.powadb-theme\.json$/, "");
}

function load(): CommunityTheme[] {
  const out: CommunityTheme[] = [];
  for (const [path, raw] of Object.entries(modules)) {
    const slug = slugFromPath(path);
    try {
      out.push({ slug, theme: fromExported(raw) });
    } catch (e) {
      if (e instanceof ThemeImportError) {
        console.warn(`[community-themes] skipping ${slug}: ${e.message}`);
      } else {
        console.warn(`[community-themes] skipping ${slug}:`, e);
      }
    }
  }
  return out.sort((a, b) => a.theme.name.localeCompare(b.theme.name));
}

export const COMMUNITY_THEMES: CommunityTheme[] = load();
