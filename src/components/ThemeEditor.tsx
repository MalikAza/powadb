import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  type CustomTheme,
  DEFAULT_RADIUS,
  presetColors,
  THEME_TOKENS,
  type ThemeBase,
  type ThemeColors,
  type ThemeToken,
  TOKEN_LABELS,
} from "@/lib/themeTokens";
import { useTheme } from "@/stores/theme";

type Draft = {
  name: string;
  base: ThemeBase;
  radius: string;
  colors: ThemeColors;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When provided, edits an existing theme; otherwise creates a new one. */
  editing?: CustomTheme | null;
  /** Used when creating from a duplicate — pre-fills with these colors. */
  seed?: { name?: string; base?: ThemeBase; colors?: ThemeColors; radius?: string } | null;
};

function emptyDraft(base: ThemeBase = "light"): Draft {
  return {
    name: "",
    base,
    radius: DEFAULT_RADIUS,
    colors: presetColors(base),
  };
}

export function ThemeEditor({ open, onOpenChange, editing, seed }: Props) {
  const upsertCustom = useTheme((s) => s.upsertCustom);
  const setSelection = useTheme((s) => s.setSelection);

  const [draft, setDraft] = useState<Draft>(() => emptyDraft());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (editing) {
      setDraft({
        name: editing.name,
        base: editing.base,
        radius: editing.radius,
        colors: { ...editing.colors },
      });
    } else if (seed) {
      setDraft({
        name: seed.name ?? "",
        base: seed.base ?? "light",
        radius: seed.radius ?? DEFAULT_RADIUS,
        colors: { ...(seed.colors ?? presetColors(seed.base ?? "light")) },
      });
    } else {
      setDraft(emptyDraft());
    }
  }, [open, editing, seed]);

  const previewStyle = useMemo(() => {
    const style: Record<string, string> = { "--radius": draft.radius };
    for (const token of THEME_TOKENS) {
      style[`--${token}`] = draft.colors[token];
    }
    return style as React.CSSProperties;
  }, [draft]);

  function patchColor(token: ThemeToken, value: string) {
    setDraft((d) => ({ ...d, colors: { ...d.colors, [token]: value } }));
  }

  function resetFromPreset(base: ThemeBase) {
    setDraft((d) => ({ ...d, base, colors: presetColors(base) }));
  }

  async function handleSave() {
    if (!draft.name.trim()) {
      toast.error("Please give the theme a name");
      return;
    }
    setSaving(true);
    try {
      const saved = await upsertCustom({
        id: editing?.id,
        name: draft.name.trim(),
        base: draft.base,
        radius: draft.radius,
        colors: draft.colors,
      });
      await setSelection({ kind: "custom", id: saved.id });
      toast.success(editing ? "Theme updated" : "Theme saved");
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit theme" : "New theme"}</DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-[1fr_1fr] gap-4">
          <div className="grid gap-3">
            <div className="grid gap-1">
              <label className="text-xs font-medium text-muted-foreground" htmlFor="theme-name">
                Name
              </label>
              <Input
                id="theme-name"
                value={draft.name}
                onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                placeholder="My theme"
              />
            </div>

            <div className="grid grid-cols-[1fr_1fr] gap-2">
              <div className="grid gap-1">
                <label className="text-xs font-medium text-muted-foreground" htmlFor="theme-base">
                  Base
                </label>
                <Select
                  value={draft.base}
                  onValueChange={(v) => setDraft((d) => ({ ...d, base: v as ThemeBase }))}
                >
                  <SelectTrigger id="theme-base">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="light">Light</SelectItem>
                    <SelectItem value="dark">Dark</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1">
                <label className="text-xs font-medium text-muted-foreground" htmlFor="theme-radius">
                  Radius
                </label>
                <Input
                  id="theme-radius"
                  value={draft.radius}
                  onChange={(e) => setDraft((d) => ({ ...d, radius: e.target.value }))}
                  placeholder="0.5rem"
                  className="font-mono text-xs"
                />
              </div>
            </div>

            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground">Colors</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => resetFromPreset(draft.base)}
                className="h-6 text-xs"
              >
                Reset from {draft.base}
              </Button>
            </div>

            <ScrollArea className="h-[420px] rounded-md border">
              <div className="grid gap-1.5 p-2">
                {THEME_TOKENS.map((token) => (
                  <ColorRow
                    key={token}
                    token={token}
                    value={draft.colors[token]}
                    onChange={(v) => patchColor(token, v)}
                  />
                ))}
              </div>
            </ScrollArea>
          </div>

          <div className="grid grid-rows-[auto_1fr] gap-2">
            <span className="text-xs font-medium text-muted-foreground">Preview</span>
            <ThemePreview style={previewStyle} base={draft.base} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ColorRow({
  token,
  value,
  onChange,
}: {
  token: ThemeToken;
  value: string;
  onChange: (v: string) => void;
}) {
  const id = `color-${token}`;
  return (
    <div className="grid grid-cols-[100px_24px_1fr] items-center gap-2">
      <label htmlFor={id} className="truncate text-[11px] text-muted-foreground" title={token}>
        {TOKEN_LABELS[token]}
      </label>
      <span
        className="size-5 rounded border"
        style={{ backgroundColor: value }}
        aria-hidden="true"
      />
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-7 font-mono text-[11px]"
        spellCheck={false}
      />
    </div>
  );
}

function ThemePreview({ style, base }: { style: React.CSSProperties; base: ThemeBase }) {
  const radiusLg = "var(--radius)";
  const radiusMd = "calc(var(--radius) - 2px)";
  const radiusSm = "calc(var(--radius) - 4px)";
  return (
    <div
      style={style}
      className={`grid h-full grid-cols-[120px_1fr] overflow-hidden rounded-[8px] border border-border bg-[var(--background)] ${
        base === "dark" ? "dark" : ""
      }`}
    >
      <div className="flex flex-col gap-2 border-r border-[var(--sidebar-border)] bg-[var(--sidebar)] p-2 text-xs text-[var(--sidebar-foreground)]">
        <div className="font-semibold">Sidebar</div>
        <div className="grid gap-1">
          <div className="px-1.5 py-1 text-[11px]" style={{ borderRadius: radiusSm }}>
            connections
          </div>
          <div
            className="bg-[var(--sidebar-accent)] px-1.5 py-1 text-[11px] text-[var(--sidebar-accent-foreground)]"
            style={{ borderRadius: radiusSm }}
          >
            active
          </div>
          <div className="px-1.5 py-1 text-[11px]" style={{ borderRadius: radiusSm }}>
            history
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-3 p-3 text-[var(--foreground)]">
        <div
          className="border border-[var(--border)] bg-[var(--card)] p-3 text-[var(--card-foreground)]"
          style={{ borderRadius: radiusLg }}
        >
          <div className="text-sm font-semibold">Card</div>
          <p className="text-xs text-[var(--muted-foreground)]">Lorem ipsum dolor sit amet.</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <button
              type="button"
              className="bg-[var(--primary)] px-2.5 py-1 text-xs text-[var(--primary-foreground)]"
              style={{ borderRadius: radiusMd }}
            >
              Primary
            </button>
            <button
              type="button"
              className="bg-[var(--secondary)] px-2.5 py-1 text-xs text-[var(--secondary-foreground)]"
              style={{ borderRadius: radiusMd }}
            >
              Secondary
            </button>
            <button
              type="button"
              className="bg-[var(--destructive)] px-2.5 py-1 text-xs text-[var(--destructive-foreground)]"
              style={{ borderRadius: radiusMd }}
            >
              Destructive
            </button>
          </div>
          <input
            readOnly
            value="Input placeholder"
            className="mt-2 w-full border border-[var(--input)] bg-[var(--background)] px-2 py-1 text-xs"
            style={{ borderRadius: radiusMd }}
          />
        </div>
        <div
          className="bg-[var(--accent)] px-2 py-1 text-xs text-[var(--accent-foreground)]"
          style={{ borderRadius: radiusSm }}
        >
          Accent surface
        </div>
        <div
          className="mt-auto flex items-center justify-between bg-[var(--muted)] px-2 py-1 text-[11px] text-[var(--muted-foreground)]"
          style={{ borderRadius: radiusSm }}
        >
          <span>status: ready</span>
          <span
            className="size-2 rounded-full"
            style={{ backgroundColor: "var(--ring)" }}
            aria-hidden="true"
          />
        </div>
      </div>
    </div>
  );
}
