import { getVersion } from "@tauri-apps/api/app";
import { CheckCircle2, Laptop, Moon, RefreshCw, Sun, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { ChangelogView } from "@/components/ChangelogView";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { runUpdateCheck } from "@/lib/updater";
import { cn } from "@/lib/utils";
import { type AppSettings, ipc } from "../ipc";
import { type ThemeMode, useTheme } from "../stores/theme";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function SettingsDialog({ open, onOpenChange }: Props) {
  const mode = useTheme((s) => s.mode);
  const setMode = useTheme((s) => s.setMode);

  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [pgStatus, setPgStatus] = useState<{ dump: string | null; client: string | null } | null>(
    null,
  );
  const [myStatus, setMyStatus] = useState<{ dump: string | null; client: string | null } | null>(
    null,
  );
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
  }, [
    open,
    settings?.pg_dump_path,
    settings?.psql_path,
    settings?.mysqldump_path,
    settings?.mysql_path,
  ]);

  function patch(p: Partial<AppSettings>) {
    if (!settings) return;
    setSettings({ ...settings, ...p });
  }

  async function persist() {
    if (!settings) return;
    const saved = await ipc.saveSettings({
      pg_dump_path: emptyToNull(settings.pg_dump_path),
      psql_path: emptyToNull(settings.psql_path),
      mysqldump_path: emptyToNull(settings.mysqldump_path),
      mysql_path: emptyToNull(settings.mysql_path),
    });
    setSettings(saved);
    onOpenChange(false);
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
            <Section title="Appearance" description="Light, dark, or follow your system theme.">
              <RadioGroup
                value={mode}
                onValueChange={(v) => setMode(v as ThemeMode)}
                className="grid grid-cols-3 gap-2"
              >
                <ThemeCard
                  value="light"
                  current={mode}
                  icon={<Sun className="size-5" />}
                  label="Light"
                />
                <ThemeCard
                  value="dark"
                  current={mode}
                  icon={<Moon className="size-5" />}
                  label="Dark"
                />
                <ThemeCard
                  value="system"
                  current={mode}
                  icon={<Laptop className="size-5" />}
                  label="System"
                />
              </RadioGroup>
            </Section>
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
      </DialogContent>
    </Dialog>
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

function ThemeCard({
  value,
  current,
  icon,
  label,
}: {
  value: ThemeMode;
  current: ThemeMode;
  icon: React.ReactNode;
  label: string;
}) {
  const selected = current === value;
  const id = `theme-${value}`;
  return (
    <label
      htmlFor={id}
      className={cn(
        "flex cursor-pointer flex-col items-center gap-2 rounded-md border p-3 transition-colors",
        selected ? "border-primary bg-primary/10" : "border-border hover:bg-accent",
      )}
    >
      <RadioGroupItem id={id} value={value} className="sr-only" />
      <span className={cn(selected ? "text-primary" : "text-muted-foreground")}>{icon}</span>
      <span className="text-xs font-medium">{label}</span>
    </label>
  );
}
