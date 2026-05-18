import { getVersion } from "@tauri-apps/api/app";
import {
  CheckCircle2,
  Download,
  Laptop,
  Moon,
  MoreVertical,
  Plus,
  RefreshCw,
  Search,
  Sun,
  Trash2,
  Upload,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ChangelogView } from "@/components/ChangelogView";
import { ThemeEditor } from "@/components/ThemeEditor";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { COMMUNITY_THEMES, type CommunityTheme } from "@/lib/communityThemes";
import { type CustomTheme, fromExported, ThemeImportError, toExported } from "@/lib/themeTokens";
import { runUpdateCheck } from "@/lib/updater";
import { cn } from "@/lib/utils";
import { type AppSettings, ipc } from "../ipc";
import { type ThemeMode, type ThemeSelection, useTheme } from "../stores/theme";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function SettingsDialog({ open, onOpenChange }: Props) {
  const selection = useTheme((s) => s.selection);
  const setSelection = useTheme((s) => s.setSelection);
  const customThemes = useTheme((s) => s.customThemes);
  const deleteCustom = useTheme((s) => s.deleteCustom);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<CustomTheme | null>(null);

  const [communityQuery, setCommunityQuery] = useState("");
  const [communityFilter, setCommunityFilter] = useState<"all" | "light" | "dark">("all");

  const filteredCommunity = useMemo(() => {
    const q = communityQuery.trim().toLowerCase();
    return COMMUNITY_THEMES.filter((c) => {
      if (communityFilter !== "all" && c.theme.base !== communityFilter) return false;
      if (q && !c.theme.name.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [communityQuery, communityFilter]);

  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [pgStatus, setPgStatus] = useState<{ dump: string | null; client: string | null } | null>(
    null,
  );
  const [myStatus, setMyStatus] = useState<{ dump: string | null; client: string | null } | null>(
    null,
  );
  const [liteStatus, setLiteStatus] = useState<{
    dump: string | null;
    client: string | null;
  } | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [tab, setTab] = useState("appearance");

  useEffect(() => {
    if (!open) return;
    ipc.getSettings().then(setSettings);
    getVersion().then(setVersion);
  }, [open]);

  async function checkForUpdate() {
    setCheckingUpdate(true);
    try {
      await runUpdateCheck({ notifyWhenUpToDate: true });
    } finally {
      setCheckingUpdate(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    ipc.checkDumpTools("postgres").then(setPgStatus);
    ipc.checkDumpTools("mysql").then(setMyStatus);
    ipc.checkDumpTools("sqlite").then(setLiteStatus);
  }, [
    open,
    settings?.pg_dump_path,
    settings?.psql_path,
    settings?.mysqldump_path,
    settings?.mysql_path,
    settings?.sqlite3_path,
  ]);

  function patch(p: Partial<AppSettings>) {
    if (!settings) return;
    setSettings({ ...settings, ...p });
  }

  async function persist() {
    if (!settings) return;
    const saved = await ipc.saveSettings({
      ...settings,
      pg_dump_path: emptyToNull(settings.pg_dump_path),
      psql_path: emptyToNull(settings.psql_path),
      mysqldump_path: emptyToNull(settings.mysqldump_path),
      mysql_path: emptyToNull(settings.mysql_path),
      sqlite3_path: emptyToNull(settings.sqlite3_path),
    });
    setSettings(saved);
    onOpenChange(false);
  }

  async function exportTheme(theme: CustomTheme) {
    const path = await ipc.pickSavePathWithFilter(
      `${theme.name || "theme"}.powadb-theme.json`,
      "PowaDB Theme",
      ["json"],
    );
    if (!path) return;
    try {
      await ipc.writeTextFile(path, JSON.stringify(toExported(theme), null, 2));
      toast.success("Theme exported");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  const upsertCustom = useTheme((s) => s.upsertCustom);
  const setActiveSelection = useTheme((s) => s.setSelection);

  async function importTheme() {
    const path = await ipc.pickOpenPathWithFilter("PowaDB Theme", ["json"]);
    if (!path) return;
    try {
      const contents = await ipc.readTextFile(path);
      const parsed = fromExported(JSON.parse(contents));
      const saved = await upsertCustom({
        name: parsed.name,
        base: parsed.base,
        radius: parsed.radius,
        colors: parsed.colors,
      });
      await setActiveSelection({ kind: "custom", id: saved.id });
      toast.success(`Imported "${saved.name}"`);
    } catch (e) {
      if (e instanceof ThemeImportError) toast.error(e.message);
      else if (e instanceof SyntaxError) toast.error("File is not valid JSON");
      else toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  async function installCommunity({ theme }: CommunityTheme) {
    try {
      const saved = await upsertCustom({
        name: theme.name,
        base: theme.base,
        radius: theme.radius,
        colors: theme.colors,
      });
      await setActiveSelection({ kind: "custom", id: saved.id });
      toast.success(`Installed "${saved.name}"`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
        </DialogHeader>

        <Tabs value={tab} onValueChange={setTab} className="gap-0">
          <TabsList className="bg-transparent p-0">
            <SettingsTab value="appearance">Appearance</SettingsTab>
            <SettingsTab value="tools">Database tools</SettingsTab>
            <SettingsTab value="about">About</SettingsTab>
            <SettingsTab value="changelog">Changelog</SettingsTab>
          </TabsList>

          <TabsContent value="appearance" className="mt-6">
            <div className="grid gap-6">
              <Section title="Built-in" description="Light, dark, or follow your system theme.">
                <div className="grid grid-cols-3 gap-2">
                  <PresetCard
                    mode="light"
                    selection={selection}
                    onPick={() => setSelection({ kind: "preset", mode: "light" })}
                    icon={<Sun className="size-5" />}
                    label="Light"
                  />
                  <PresetCard
                    mode="dark"
                    selection={selection}
                    onPick={() => setSelection({ kind: "preset", mode: "dark" })}
                    icon={<Moon className="size-5" />}
                    label="Dark"
                  />
                  <PresetCard
                    mode="system"
                    selection={selection}
                    onPick={() => setSelection({ kind: "preset", mode: "system" })}
                    icon={<Laptop className="size-5" />}
                    label="System"
                  />
                </div>
              </Section>

              <Section
                title="Custom themes"
                description="Design your own palette, or import one shared by someone else."
              >
                <div className="grid gap-2">
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setEditing(null);
                        setEditorOpen(true);
                      }}
                    >
                      <Plus className="size-3.5" />
                      New theme
                    </Button>
                    <Button size="sm" variant="outline" onClick={importTheme}>
                      <Upload className="size-3.5" />
                      Import
                    </Button>
                  </div>

                  {customThemes.length === 0 ? (
                    <div className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">
                      No custom themes yet.
                    </div>
                  ) : (
                    <ScrollArea className="h-[208px] rounded-md border">
                      <div className="grid gap-1 p-1 pr-3">
                        {customThemes.map((t) => (
                          <CustomThemeRow
                            key={t.id}
                            theme={t}
                            active={selection.kind === "custom" && selection.id === t.id}
                            onSelect={() => setSelection({ kind: "custom", id: t.id })}
                            onEdit={() => {
                              setEditing(t);
                              setEditorOpen(true);
                            }}
                            onDelete={() => deleteCustom(t.id)}
                            onExport={() => exportTheme(t)}
                          />
                        ))}
                      </div>
                    </ScrollArea>
                  )}
                </div>
              </Section>

              {COMMUNITY_THEMES.length > 0 && (
                <Section
                  title="Community themes"
                  description="Curated palettes shipped with PowaDB. Install one to add a copy to your custom themes."
                >
                  <div className="grid gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="relative min-w-0 flex-1">
                        <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                        <Input
                          value={communityQuery}
                          onChange={(e) => setCommunityQuery(e.target.value)}
                          placeholder="Search themes…"
                          className="h-8 pl-7 text-xs"
                          spellCheck={false}
                        />
                      </div>
                      <div className="flex items-center gap-0.5 rounded-md border border-border p-0.5">
                        <FilterPill
                          active={communityFilter === "all"}
                          onClick={() => setCommunityFilter("all")}
                        >
                          All
                        </FilterPill>
                        <FilterPill
                          active={communityFilter === "light"}
                          onClick={() => setCommunityFilter("light")}
                          icon={<Sun className="size-3" />}
                        >
                          Light
                        </FilterPill>
                        <FilterPill
                          active={communityFilter === "dark"}
                          onClick={() => setCommunityFilter("dark")}
                          icon={<Moon className="size-3" />}
                        >
                          Dark
                        </FilterPill>
                      </div>
                    </div>

                    {filteredCommunity.length === 0 ? (
                      <div className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">
                        No themes match.
                      </div>
                    ) : (
                      <ScrollArea className="h-[208px] rounded-md border">
                        <div className="grid gap-1 p-1 pr-3">
                          {filteredCommunity.map((c) => (
                            <CommunityThemeRow
                              key={c.slug}
                              community={c}
                              onInstall={() => installCommunity(c)}
                            />
                          ))}
                        </div>
                      </ScrollArea>
                    )}
                  </div>
                </Section>
              )}
            </div>
          </TabsContent>

          <TabsContent value="tools" className="mt-6">
            <Section
              title="Database tools"
              description="Override paths to pg_dump / psql / mysqldump / mysql. Leave blank to use whatever is on your PATH."
            >
              <div className="grid gap-3">
                <ToolPath
                  label="pg_dump"
                  value={settings?.pg_dump_path ?? ""}
                  onChange={(v) => patch({ pg_dump_path: v })}
                  resolved={pgStatus?.dump ?? null}
                />
                <ToolPath
                  label="psql"
                  value={settings?.psql_path ?? ""}
                  onChange={(v) => patch({ psql_path: v })}
                  resolved={pgStatus?.client ?? null}
                />
                <ToolPath
                  label="mysqldump"
                  value={settings?.mysqldump_path ?? ""}
                  onChange={(v) => patch({ mysqldump_path: v })}
                  resolved={myStatus?.dump ?? null}
                />
                <ToolPath
                  label="mysql"
                  value={settings?.mysql_path ?? ""}
                  onChange={(v) => patch({ mysql_path: v })}
                  resolved={myStatus?.client ?? null}
                />
                <ToolPath
                  label="sqlite3"
                  value={settings?.sqlite3_path ?? ""}
                  onChange={(v) => patch({ sqlite3_path: v })}
                  resolved={liteStatus?.dump ?? null}
                />
              </div>
            </Section>
          </TabsContent>

          <TabsContent value="about" className="mt-6">
            <Section title="About">
              <div className="flex items-center justify-between gap-3">
                <div className="text-xs text-muted-foreground">
                  PowaDB <span className="font-mono">v{version ?? "…"}</span>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={checkForUpdate}
                  disabled={checkingUpdate}
                >
                  <RefreshCw className={cn("size-3.5", checkingUpdate && "animate-spin")} />
                  Check for updates
                </Button>
              </div>
            </Section>
          </TabsContent>

          <TabsContent value="changelog" className="mt-6">
            <ChangelogView currentVersion={version} />
          </TabsContent>
        </Tabs>

        {tab === "tools" && (
          <DialogFooter className="mt-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button onClick={persist}>Save</Button>
          </DialogFooter>
        )}

        <ThemeEditor open={editorOpen} onOpenChange={setEditorOpen} editing={editing} />
      </DialogContent>
    </Dialog>
  );
}

function PresetCard({
  mode,
  selection,
  onPick,
  icon,
  label,
}: {
  mode: ThemeMode;
  selection: ThemeSelection;
  onPick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  const selected = selection.kind === "preset" && selection.mode === mode;
  return (
    <button
      type="button"
      onClick={onPick}
      className={cn(
        "flex cursor-pointer flex-col items-center gap-2 rounded-md border p-3 transition-colors",
        selected ? "border-primary bg-primary/10" : "border-border hover:bg-accent",
      )}
    >
      <span className={cn(selected ? "text-primary" : "text-muted-foreground")}>{icon}</span>
      <span className="text-xs font-medium">{label}</span>
    </button>
  );
}

function FilterPill({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-1 rounded-sm px-2 py-1 text-[11px] font-medium transition-colors",
        active
          ? "bg-primary text-primary-foreground"
          : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      {icon}
      {children}
    </button>
  );
}

function CommunityThemeRow({
  community,
  onInstall,
}: {
  community: CommunityTheme;
  onInstall: () => void;
}) {
  const swatches: Array<keyof typeof community.theme.colors> = [
    "primary",
    "background",
    "accent",
    "border",
  ];
  return (
    <div className="flex items-center gap-3 rounded-md border border-border p-2">
      <div className="flex gap-1">
        {swatches.map((token) => (
          <span
            key={token}
            className="size-4 rounded-sm border"
            style={{ backgroundColor: community.theme.colors[token] }}
            aria-hidden="true"
          />
        ))}
      </div>
      <div className="flex flex-1 items-center gap-2">
        <span className="text-sm font-medium">{community.theme.name}</span>
        <span className="text-[11px] text-muted-foreground">{community.theme.base}</span>
      </div>
      <Button variant="ghost" size="sm" onClick={onInstall} className="h-7 px-2">
        <Download className="size-3.5" />
        Install
      </Button>
    </div>
  );
}

function CustomThemeRow({
  theme,
  active,
  onSelect,
  onEdit,
  onDelete,
  onExport,
}: {
  theme: CustomTheme;
  active: boolean;
  onSelect: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onExport: () => void;
}) {
  const swatches: Array<keyof typeof theme.colors> = ["primary", "background", "accent", "border"];
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-md border p-2 transition-colors",
        active ? "border-primary bg-primary/10" : "border-border hover:bg-accent",
      )}
    >
      <button type="button" onClick={onSelect} className="flex flex-1 items-center gap-3 text-left">
        <div className="flex gap-1">
          {swatches.map((token) => (
            <span
              key={token}
              className="size-4 rounded-sm border"
              style={{ backgroundColor: theme.colors[token] }}
              aria-hidden="true"
            />
          ))}
        </div>
        <span className="text-sm font-medium">{theme.name}</span>
        <span className="text-[11px] text-muted-foreground">{theme.base}</span>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="h-7 px-1.5">
            <MoreVertical className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={onEdit}>
            <Plus className="size-3.5" />
            Edit
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onExport}>
            <Download className="size-3.5" />
            Export
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onDelete} variant="destructive">
            <Trash2 className="size-3.5" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function SettingsTab({ value, children }: { value: string; children: React.ReactNode }) {
  return (
    <TabsTrigger
      value={value}
      className="h-full flex-none rounded-none border-0 border-b-2 border-transparent px-3 text-sm data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none"
    >
      {children}
    </TabsTrigger>
  );
}

function emptyToNull(s: string | null | undefined): string | null {
  const t = (s ?? "").trim();
  return t === "" ? null : t;
}

function ToolPath({
  label,
  value,
  onChange,
  resolved,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  resolved: string | null;
}) {
  const id = `tool-path-${label}`;
  return (
    <div className="grid gap-1">
      <div className="flex items-center gap-2">
        <label htmlFor={id} className="w-20 text-xs font-medium text-muted-foreground">
          {label}
        </label>
        <Input
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={`/usr/local/bin/${label}`}
          className="flex-1 font-mono text-xs"
        />
      </div>
      <div className="ml-22 flex items-center gap-1 text-[11px] text-muted-foreground">
        {resolved ? (
          <>
            <CheckCircle2 className="size-3 text-primary" />
            <span className="truncate font-mono">{resolved}</span>
          </>
        ) : (
          <>
            <XCircle className="size-3 text-destructive" />
            <span>Not found</span>
          </>
        )}
      </div>
    </div>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-2">
      <div>
        <h4 className="text-sm font-semibold">{title}</h4>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
      </div>
      {children}
    </div>
  );
}
