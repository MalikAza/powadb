# Community themes

This folder holds the validated, ship-with-the-app theme presets that show up under **Settings → Appearance → Community themes**.

Each file is a single PowaDB theme export, the same format the in-app **Export** button produces. Files use the `.powadb-theme.json` suffix and follow the `powadb-theme/v1` schema:

```json
{
  "schema": "powadb-theme/v1",
  "name": "My Theme",
  "base": "light",
  "radius": "0.5rem",
  "colors": {
    "background": "#ffffff",
    "foreground": "#111111",
    "card": "...",
    "...": "..."
  }
}
```

The `colors` object must include every token listed in [`src/lib/themeTokens.ts`](../src/lib/themeTokens.ts) (`THEME_TOKENS`). Any valid CSS color works — hex, `oklch(...)`, `rgb(...)`, named colors.

## Contributing a theme

1. Inside the app, design your theme in **Settings → Appearance → New theme**, then **Export** it.
2. Drop the JSON into this folder, renamed to `kebab-case.powadb-theme.json`.
3. Run `npm run validate:themes` — it parses every file, checks the schema, and reports anything missing.
4. Open a pull request. CI runs the same validation.

## What ships today

| File | Base | Origin |
| --- | --- | --- |
| `catppuccin-latte.powadb-theme.json` | light | [Catppuccin](https://catppuccin.com) |
| `catppuccin-mocha.powadb-theme.json` | dark | [Catppuccin](https://catppuccin.com) |
| `dracula.powadb-theme.json` | dark | [Dracula](https://draculatheme.com) |
| `gruvbox-dark.powadb-theme.json` | dark | [Gruvbox](https://github.com/morhetz/gruvbox) |
| `nord.powadb-theme.json` | dark | [Nord](https://www.nordtheme.com) |
| `solarized-dark.powadb-theme.json` | dark | [Solarized](https://ethanschoonover.com/solarized/) |
| `solarized-light.powadb-theme.json` | light | [Solarized](https://ethanschoonover.com/solarized/) |
| `tokyo-night.powadb-theme.json` | dark | [Tokyo Night](https://github.com/folke/tokyonight.nvim) |

Color palettes are attributions to their respective authors; only the PowaDB token mapping lives here.
