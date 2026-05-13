import { zodResolver } from "@hookform/resolvers/zod";
import { Eye, EyeOff, FolderOpen } from "lucide-react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  CONNECTION_COLORS,
  type ConnectionFormInput,
  type ConnectionFormValues,
  connectionFormSchema,
  type DbKindEnum,
  KIND_DEFAULTS,
  ROOT_FOLDER_SENTINEL,
} from "@/lib/schemas";
import { ipc } from "../ipc";
import { useConnections } from "../stores/connections";
import type { ConnectionInput, SavedConnection } from "../types";
import { folderPaths } from "../utils/folderTree";

type Props = {
  editingId: string | null;
  initialFolderId?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function ConnectionForm({ editingId, initialFolderId, open, onOpenChange }: Props) {
  const { connections, folders, save } = useConnections();
  const editing: SavedConnection | undefined = connections.find((c) => c.id === editingId);
  const isEditing = !!editing;

  const [showPassword, setShowPassword] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [step, setStep] = useState<1 | 2>(1);

  const form = useForm<ConnectionFormInput, unknown, ConnectionFormValues>({
    resolver: zodResolver(connectionFormSchema),
    defaultValues: {
      name: editing?.name ?? "Local Postgres",
      kind: editing?.kind ?? "postgres",
      host: editing?.host ?? "localhost",
      port: editing?.port ?? KIND_DEFAULTS.postgres.port,
      database: editing?.database ?? KIND_DEFAULTS.postgres.database,
      username: editing?.username ?? KIND_DEFAULTS.postgres.username,
      password: "",
      ssl: editing?.ssl ?? false,
      folder_id: editing?.folder_id ?? initialFolderId ?? ROOT_FOLDER_SENTINEL,
      color: editing?.color ?? null,
      wg_enabled: !!editing?.wg,
      wg_config: "",
    },
  });

  // Load existing password / WG config from backend when editing
  useEffect(() => {
    if (!editing) return;
    ipc.getConnectionPassword(editing.id).then((pw) => {
      if (pw) form.setValue("password", pw);
    });
    if (editing.wg) {
      ipc.getConnectionWgConfig(editing.id).then((cfg) => {
        if (cfg) form.setValue("wg_config", cfg);
      });
    }
  }, [editing?.id]);

  // When kind changes on a new connection, swap default port/db/user
  const watchedKind = form.watch("kind") as DbKindEnum;
  useEffect(() => {
    if (isEditing) return;
    const d = KIND_DEFAULTS[watchedKind];
    form.setValue("port", d.port);
    const currentDb = form.getValues("database");
    if (!currentDb) form.setValue("database", d.database);
    const currentUser = form.getValues("username");
    if (!currentUser || currentUser === "postgres" || currentUser === "root") {
      form.setValue("username", d.username);
    }
  }, [watchedKind]);

  const isSqlite = watchedKind === "sqlite";
  const wgEnabled = form.watch("wg_enabled");
  const isMultiStep = wgEnabled && !isSqlite;

  useEffect(() => {
    if (open) setStep(1);
  }, [open]);
  useEffect(() => {
    if (!isMultiStep) setStep(1);
  }, [isMultiStep]);

  const STEP1_FIELDS = [
    "name",
    "kind",
    "host",
    "port",
    "database",
    "username",
    "password",
    "ssl",
    "folder_id",
    "color",
    "wg_enabled",
  ] as const;

  async function goToStep2() {
    setSubmitError(null);
    const ok = await form.trigger([...STEP1_FIELDS]);
    if (ok) setStep(2);
  }

  async function pickSqlitePath() {
    const picked = await ipc.pickSqlitePath();
    if (picked) form.setValue("database", picked);
  }

  async function pickWgConfPath() {
    const picked = await ipc.pickWgConfPath();
    if (!picked) return;
    try {
      const text = await ipc.readTextFile(picked);
      form.setValue("wg_config", text, { shouldValidate: true });
    } catch (err) {
      setSubmitError(`Could not read ${picked}: ${String(err)}`);
    }
  }

  async function onSubmit(values: ConnectionFormValues) {
    if (isMultiStep && step === 1) {
      setStep(2);
      return;
    }
    setSubmitError(null);
    try {
      const input: ConnectionInput = {
        id: editing?.id,
        name: values.name,
        kind: values.kind,
        host: values.host,
        port: values.port,
        database: values.database,
        username: values.username,
        ssl: values.ssl,
        folder_id: values.folder_id,
        color: values.color,
        ...(values.password ? { password: values.password } : {}),
        wg_enabled: values.wg_enabled,
        ...(values.wg_enabled ? { wg_config: values.wg_config } : {}),
      };
      await save(input);
      onOpenChange(false);
    } catch (err) {
      setSubmitError(String(err));
    }
  }

  const paths = folderPaths(folders);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isEditing ? "Edit connection" : "New connection"}</DialogTitle>
          {isMultiStep && (
            <p className="text-xs font-normal text-muted-foreground">
              Step {step} of 2 — {step === 1 ? "connection" : "WireGuard tunnel"}
            </p>
          )}
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="grid gap-3">
            {step === 1 && (
              <>
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-xs font-normal text-muted-foreground">
                        Name
                      </FormLabel>
                      <FormControl>
                        <Input {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="kind"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-xs font-normal text-muted-foreground">
                        Type
                      </FormLabel>
                      <Select value={field.value} onValueChange={field.onChange}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="postgres">PostgreSQL</SelectItem>
                          <SelectItem value="mysql">MySQL / MariaDB</SelectItem>
                          <SelectItem value="sqlite">SQLite</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {!isSqlite && (
                  <div className="grid grid-cols-[2fr_1fr] gap-3">
                    <FormField
                      control={form.control}
                      name="host"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-xs font-normal text-muted-foreground">
                            Host
                          </FormLabel>
                          <FormControl>
                            <Input {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="port"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-xs font-normal text-muted-foreground">
                            Port
                          </FormLabel>
                          <FormControl>
                            <Input type="number" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>
                )}

                <FormField
                  control={form.control}
                  name="database"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-xs font-normal text-muted-foreground">
                        {isSqlite ? "Database file" : "Database (optional)"}
                      </FormLabel>
                      <FormControl>
                        {isSqlite ? (
                          <div className="flex gap-2">
                            <Input {...field} placeholder="/path/to/database.db" />
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={pickSqlitePath}
                            >
                              <FolderOpen className="size-3.5" />
                              Browse…
                            </Button>
                          </div>
                        ) : (
                          <Input {...field} placeholder="leave empty to pick later" />
                        )}
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {!isSqlite && (
                  <>
                    <FormField
                      control={form.control}
                      name="username"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-xs font-normal text-muted-foreground">
                            Username
                          </FormLabel>
                          <FormControl>
                            <Input {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    <FormField
                      control={form.control}
                      name="password"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-xs font-normal text-muted-foreground">
                            Password
                          </FormLabel>
                          <FormControl>
                            <div className="relative">
                              <Input
                                type={showPassword ? "text" : "password"}
                                autoComplete="new-password"
                                className="pr-9"
                                {...field}
                              />
                              <button
                                type="button"
                                onClick={() => setShowPassword((v) => !v)}
                                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                                tabIndex={-1}
                                aria-label={showPassword ? "Hide password" : "Show password"}
                              >
                                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                              </button>
                            </div>
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    <FormField
                      control={form.control}
                      name="ssl"
                      render={({ field }) => (
                        <FormItem className="flex items-center gap-2 space-y-0">
                          <FormControl>
                            <Checkbox checked={field.value} onCheckedChange={field.onChange} />
                          </FormControl>
                          <FormLabel className="cursor-pointer text-xs font-normal">
                            Require TLS
                          </FormLabel>
                        </FormItem>
                      )}
                    />

                    <FormField
                      control={form.control}
                      name="wg_enabled"
                      render={({ field }) => (
                        <FormItem className="flex items-center gap-2 space-y-0">
                          <FormControl>
                            <Checkbox checked={field.value} onCheckedChange={field.onChange} />
                          </FormControl>
                          <FormLabel className="cursor-pointer text-xs font-normal">
                            Connect through WireGuard tunnel
                          </FormLabel>
                        </FormItem>
                      )}
                    />
                  </>
                )}

                <FormField
                  control={form.control}
                  name="color"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-xs font-normal text-muted-foreground">
                        Color tag
                      </FormLabel>
                      <FormControl>
                        <div className="flex flex-wrap gap-1.5">
                          {CONNECTION_COLORS.map((c) => {
                            const selected = (field.value ?? null) === c.value;
                            const isNone = c.value === null;
                            return (
                              <button
                                key={c.name}
                                type="button"
                                onClick={() => field.onChange(c.value)}
                                aria-label={c.name}
                                title={c.name}
                                className={`size-6 rounded-full border transition-all ${
                                  selected
                                    ? "border-foreground ring-2 ring-foreground/30"
                                    : "border-border hover:scale-110"
                                } ${isNone ? "bg-transparent" : ""}`}
                                style={isNone ? undefined : { backgroundColor: c.swatch }}
                              >
                                {isNone && (
                                  <span className="text-[10px] text-muted-foreground">∅</span>
                                )}
                              </button>
                            );
                          })}
                        </div>
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="folder_id"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-xs font-normal text-muted-foreground">
                        Folder
                      </FormLabel>
                      <Select
                        value={field.value ?? ROOT_FOLDER_SENTINEL}
                        onValueChange={field.onChange}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value={ROOT_FOLDER_SENTINEL}>(top level)</SelectItem>
                          {paths.map((p) => (
                            <SelectItem key={p.folder.id} value={p.folder.id}>
                              {p.path}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </>
            )}

            {step === 2 && (
              <div className="grid gap-3">
                <p className="text-xs text-muted-foreground">
                  Paste the contents of your <code>wireguard.conf</code> below, or load it from a
                  file. The DB <em>Host</em> and <em>Port</em> you set on step 1 must be a private
                  IP that the WireGuard peer's <code>AllowedIPs</code> covers.
                </p>
                <FormField
                  control={form.control}
                  name="wg_config"
                  render={({ field }) => (
                    <FormItem>
                      <div className="flex items-center justify-between">
                        <FormLabel className="text-xs font-normal text-muted-foreground">
                          wireguard.conf
                        </FormLabel>
                        <Button type="button" variant="outline" size="sm" onClick={pickWgConfPath}>
                          <FolderOpen className="size-3.5" />
                          Load file…
                        </Button>
                      </div>
                      <FormControl>
                        <textarea
                          {...field}
                          rows={12}
                          spellCheck={false}
                          autoCorrect="off"
                          autoCapitalize="off"
                          placeholder={
                            "[Interface]\nPrivateKey = …\nAddress = 10.0.0.2/32\n\n[Peer]\nPublicKey = …\nEndpoint = vpn.example.com:51820\nAllowedIPs = 10.0.0.0/16\n"
                          }
                          className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs shadow-xs transition-colors placeholder:text-muted-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            )}

            {submitError && <p className="text-xs text-destructive">{submitError}</p>}
            {Object.keys(form.formState.errors).length > 0 && (
              <p className="text-xs text-destructive">
                {Object.entries(form.formState.errors)
                  .map(([field, err]) => `${field}: ${err?.message ?? "invalid"}`)
                  .join(" · ")}
              </p>
            )}

            <DialogFooter className="mt-2">
              {step === 2 ? (
                <Button type="button" variant="ghost" onClick={() => setStep(1)}>
                  ← Back
                </Button>
              ) : (
                <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                  Cancel
                </Button>
              )}
              {isMultiStep && step === 1 ? (
                <Button type="button" onClick={goToStep2}>
                  Next →
                </Button>
              ) : (
                <Button type="submit" disabled={form.formState.isSubmitting}>
                  {form.formState.isSubmitting ? "Saving…" : "Save"}
                </Button>
              )}
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
