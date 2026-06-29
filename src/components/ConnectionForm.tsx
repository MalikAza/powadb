import { zodResolver } from "@hookform/resolvers/zod";
import { Eye, EyeOff, FolderOpen } from "lucide-react";
import { useEffect, useState } from "react";
import { type UseFormReturn, useForm } from "react-hook-form";
import { ColorPicker } from "@/components/ColorPicker";
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
  type ConnectionFormInput,
  type ConnectionFormValues,
  connectionFormSchema,
  KIND_DEFAULTS,
  ROOT_FOLDER_SENTINEL,
} from "@/lib/schemas";
import { ipc } from "../ipc";
import { useConnections } from "../stores/connections";
import type { ConnectionInput, DbKind, SavedConnection, SshConfigPayload } from "../types";
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
      ssh_enabled: !!editing?.ssh,
      ssh_host: "",
      ssh_port: 22,
      ssh_username: "",
      ssh_auth_method: "key",
      ssh_password: "",
      ssh_key_path: "",
      ssh_passphrase: "",
      ssh_known_host_fingerprint: null,
    },
  });

  // Load existing password / WG config / SSH config from backend when editing.
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
    if (editing.ssh) {
      ipc.getConnectionSshConfig(editing.id).then((cfg) => {
        if (!cfg) return;
        try {
          const parsed = JSON.parse(cfg) as SshConfigPayload;
          form.setValue("ssh_host", parsed.host ?? "");
          form.setValue("ssh_port", parsed.port ?? 22);
          form.setValue("ssh_username", parsed.username ?? "");
          form.setValue("ssh_known_host_fingerprint", parsed.known_host_fingerprint ?? null);
          if (parsed.auth?.kind === "password") {
            form.setValue("ssh_auth_method", "password");
            form.setValue("ssh_password", parsed.auth.password ?? "");
          } else if (parsed.auth?.kind === "private_key") {
            form.setValue("ssh_auth_method", "key");
            form.setValue("ssh_key_path", parsed.auth.path ?? "");
            form.setValue("ssh_passphrase", parsed.auth.passphrase ?? "");
          }
        } catch {
          // Malformed stored config — leave fields blank so the user can re-enter.
        }
      });
    }
  }, [editing?.id]);

  // When kind changes on a new connection, swap default port/db/user
  const watchedKind = form.watch("kind") as DbKind;
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
  const isS3 = watchedKind === "s3";
  const wgEnabled = form.watch("wg_enabled");
  const sshEnabled = form.watch("ssh_enabled");
  const isMultiStep = (wgEnabled || sshEnabled) && !isSqlite && !isS3;
  const sshAuthMethod = form.watch("ssh_auth_method");

  useEffect(() => {
    if (open) setStep(1);
  }, [open]);
  useEffect(() => {
    if (!isMultiStep) setStep(1);
  }, [isMultiStep]);

  // Mutual exclusion: WireGuard and SSH cannot both be enabled.
  useEffect(() => {
    if (wgEnabled && sshEnabled) {
      form.setValue("ssh_enabled", false);
    }
  }, [wgEnabled]);
  useEffect(() => {
    if (wgEnabled && sshEnabled) {
      form.setValue("wg_enabled", false);
    }
  }, [sshEnabled]);

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
    "ssh_enabled",
  ] as const;

  async function goToStep2(e?: React.MouseEvent) {
    // Defensive: the Next/Save button share a slot in the footer, and when
    // React swaps the type from "button" to "submit" mid-click some webviews
    // re-deliver the click and immediately submit the form. Stopping the event
    // here keeps the click from leaking into the freshly-rendered Save button.
    e?.preventDefault();
    e?.stopPropagation();
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

  async function pickSshKeyPath() {
    const picked = await ipc.pickSshKeyPath();
    if (picked) form.setValue("ssh_key_path", picked, { shouldValidate: true });
  }

  async function onSubmit(values: ConnectionFormValues) {
    if (isMultiStep && step === 1) {
      setStep(2);
      return;
    }
    setSubmitError(null);
    try {
      let sshConfigJson: string | undefined;
      if (values.ssh_enabled) {
        const payload: SshConfigPayload = {
          host: values.ssh_host,
          port: values.ssh_port,
          username: values.ssh_username,
          auth:
            values.ssh_auth_method === "password"
              ? { kind: "password", password: values.ssh_password }
              : {
                  kind: "private_key",
                  path: values.ssh_key_path,
                  passphrase: values.ssh_passphrase || null,
                },
          known_host_fingerprint: values.ssh_known_host_fingerprint ?? null,
        };
        sshConfigJson = JSON.stringify(payload);
      }
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
        ssh_enabled: values.ssh_enabled,
        ...(sshConfigJson !== undefined ? { ssh_config: sshConfigJson } : {}),
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
              Step {step} of 2: {step === 1 ? "connection" : "WireGuard tunnel"}
            </p>
          )}
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="grid gap-3">
            {step === 1 && (
              <Step1Connection
                form={form}
                isSqlite={isSqlite}
                isS3={isS3}
                showPassword={showPassword}
                onToggleShowPassword={() => setShowPassword((v) => !v)}
                onPickSqlitePath={pickSqlitePath}
                folderOptions={paths.map((p) => ({ id: p.folder.id, path: p.path }))}
              />
            )}

            {step === 2 && wgEnabled && (
              <Step2WireGuard form={form} onPickWgConfPath={pickWgConfPath} />
            )}

            {step === 2 && sshEnabled && (
              <Step2Ssh
                form={form}
                sshAuthMethod={sshAuthMethod}
                onPickSshKeyPath={pickSshKeyPath}
              />
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
                <Button key="next" type="button" onClick={goToStep2}>
                  Next →
                </Button>
              ) : (
                <Button key="save" type="submit" disabled={form.formState.isSubmitting}>
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

type ConnectionFormHandle = UseFormReturn<ConnectionFormInput, unknown, ConnectionFormValues>;

type Step1Props = {
  form: ConnectionFormHandle;
  isSqlite: boolean;
  isS3: boolean;
  showPassword: boolean;
  onToggleShowPassword: () => void;
  onPickSqlitePath: () => void;
  folderOptions: { id: string; path: string }[];
};

function Step1Connection({
  form,
  isSqlite,
  isS3,
  showPassword,
  onToggleShowPassword,
  onPickSqlitePath,
  folderOptions,
}: Step1Props) {
  return (
    <>
      <FormField
        control={form.control}
        name="name"
        render={({ field }) => (
          <FormItem>
            <FormLabel className="text-xs font-normal text-muted-foreground">Name</FormLabel>
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
            <FormLabel className="text-xs font-normal text-muted-foreground">Type</FormLabel>
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
                <SelectItem value="mongo">MongoDB</SelectItem>
                <SelectItem value="s3">S3 / Object storage</SelectItem>
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
                  {isS3 ? "Endpoint host" : "Host"}
                </FormLabel>
                <FormControl>
                  <Input {...field} placeholder={isS3 ? "s3.gra.io.cloud.ovh.net" : undefined} />
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
                <FormLabel className="text-xs font-normal text-muted-foreground">Port</FormLabel>
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
              {isSqlite ? "Database file" : isS3 ? "Region (optional)" : "Database (optional)"}
            </FormLabel>
            <FormControl>
              {isSqlite ? (
                <div className="flex gap-2">
                  <Input {...field} placeholder="/path/to/database.db" />
                  <Button type="button" variant="outline" size="sm" onClick={onPickSqlitePath}>
                    <FolderOpen className="size-3.5" />
                    Browse…
                  </Button>
                </div>
              ) : (
                <Input
                  {...field}
                  placeholder={isS3 ? "us-east-1 (default)" : "leave empty to pick later"}
                />
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
                  {isS3 ? "Access key" : "Username"}
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
                      onClick={onToggleShowPassword}
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
              <FormItem className="flex items-center gap-x-2 gap-y-0">
                <FormControl>
                  <Checkbox checked={field.value} onCheckedChange={field.onChange} />
                </FormControl>
                <FormLabel className="cursor-pointer text-xs font-normal">
                  {isS3 ? "Use HTTPS" : "Require TLS"}
                </FormLabel>
              </FormItem>
            )}
          />

          {!isS3 && (
            <>
              <FormField
                control={form.control}
                name="wg_enabled"
                render={({ field }) => (
                  <FormItem className="flex items-center gap-x-2 gap-y-0">
                    <FormControl>
                      <Checkbox checked={field.value} onCheckedChange={field.onChange} />
                    </FormControl>
                    <FormLabel className="cursor-pointer text-xs font-normal">
                      Connect through WireGuard tunnel
                    </FormLabel>
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="ssh_enabled"
                render={({ field }) => (
                  <FormItem className="flex items-center gap-x-2 gap-y-0">
                    <FormControl>
                      <Checkbox checked={field.value} onCheckedChange={field.onChange} />
                    </FormControl>
                    <FormLabel className="cursor-pointer text-xs font-normal">
                      Connect through SSH tunnel
                    </FormLabel>
                  </FormItem>
                )}
              />
            </>
          )}
        </>
      )}

      <FormField
        control={form.control}
        name="color"
        render={({ field }) => (
          <FormItem>
            <FormLabel className="text-xs font-normal text-muted-foreground">Color tag</FormLabel>
            <FormControl>
              <ColorPicker value={field.value ?? null} onChange={field.onChange} />
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
            <FormLabel className="text-xs font-normal text-muted-foreground">Folder</FormLabel>
            <Select value={field.value ?? ROOT_FOLDER_SENTINEL} onValueChange={field.onChange}>
              <FormControl>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
              </FormControl>
              <SelectContent>
                <SelectItem value={ROOT_FOLDER_SENTINEL}>(top level)</SelectItem>
                {folderOptions.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
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
  );
}

type Step2WireGuardProps = {
  form: ConnectionFormHandle;
  onPickWgConfPath: () => void;
};

function Step2WireGuard({ form, onPickWgConfPath }: Step2WireGuardProps) {
  return (
    <div className="grid gap-3">
      <p className="text-xs text-muted-foreground">
        Paste the contents of your <code>wireguard.conf</code> below, or load it from a file. The DB{" "}
        <em>Host</em> and <em>Port</em> you set on step 1 must be a private IP that the WireGuard
        peer's <code>AllowedIPs</code> covers.
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
              <Button type="button" variant="outline" size="sm" onClick={onPickWgConfPath}>
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
  );
}

type Step2SshProps = {
  form: ConnectionFormHandle;
  sshAuthMethod: ConnectionFormInput["ssh_auth_method"];
  onPickSshKeyPath: () => void;
};

function Step2Ssh({ form, sshAuthMethod, onPickSshKeyPath }: Step2SshProps) {
  return (
    <div className="grid gap-3">
      <p className="text-xs text-muted-foreground">
        PowaDB will open an SSH session to the host below and tunnel the DB connection through it.
        The <em>Host</em> on step 1 is the DB address as seen <em>from the SSH server</em>, usually{" "}
        <code>127.0.0.1</code>.
      </p>

      <div className="grid grid-cols-[2fr_1fr] gap-3">
        <FormField
          control={form.control}
          name="ssh_host"
          render={({ field }) => (
            <FormItem>
              <FormLabel className="text-xs font-normal text-muted-foreground">SSH host</FormLabel>
              <FormControl>
                <Input placeholder="vps.example.com" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="ssh_port"
          render={({ field }) => (
            <FormItem>
              <FormLabel className="text-xs font-normal text-muted-foreground">Port</FormLabel>
              <FormControl>
                <Input type="number" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      </div>

      <FormField
        control={form.control}
        name="ssh_username"
        render={({ field }) => (
          <FormItem>
            <FormLabel className="text-xs font-normal text-muted-foreground">
              SSH username
            </FormLabel>
            <FormControl>
              <Input placeholder="deploy" {...field} />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={form.control}
        name="ssh_auth_method"
        render={({ field }) => (
          <FormItem>
            <FormLabel className="text-xs font-normal text-muted-foreground">
              Authentication
            </FormLabel>
            <Select value={field.value} onValueChange={field.onChange}>
              <FormControl>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
              </FormControl>
              <SelectContent>
                <SelectItem value="key">Private key</SelectItem>
                <SelectItem value="password">Password</SelectItem>
              </SelectContent>
            </Select>
            <FormMessage />
          </FormItem>
        )}
      />

      {sshAuthMethod === "key" ? (
        <>
          <FormField
            control={form.control}
            name="ssh_key_path"
            render={({ field }) => (
              <FormItem>
                <div className="flex items-center justify-between">
                  <FormLabel className="text-xs font-normal text-muted-foreground">
                    Private key file
                  </FormLabel>
                  <Button type="button" variant="outline" size="sm" onClick={onPickSshKeyPath}>
                    <FolderOpen className="size-3.5" />
                    Browse…
                  </Button>
                </div>
                <FormControl>
                  <Input placeholder="~/.ssh/id_ed25519" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="ssh_passphrase"
            render={({ field }) => (
              <FormItem>
                <FormLabel className="text-xs font-normal text-muted-foreground">
                  Key passphrase (optional)
                </FormLabel>
                <FormControl>
                  <Input type="password" autoComplete="new-password" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </>
      ) : (
        <FormField
          control={form.control}
          name="ssh_password"
          render={({ field }) => (
            <FormItem>
              <FormLabel className="text-xs font-normal text-muted-foreground">
                SSH password
              </FormLabel>
              <FormControl>
                <Input type="password" autoComplete="new-password" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      )}

      <FormField
        control={form.control}
        name="ssh_known_host_fingerprint"
        render={({ field }) => (
          <FormItem>
            <FormLabel className="text-xs font-normal text-muted-foreground">
              Pinned host key (auto-filled on first connect)
            </FormLabel>
            <FormControl>
              <Input
                placeholder="SHA256:… (leave empty for trust-on-first-use)"
                value={field.value ?? ""}
                onChange={(e) => field.onChange(e.target.value || null)}
                onBlur={field.onBlur}
                name={field.name}
                ref={field.ref}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
    </div>
  );
}
