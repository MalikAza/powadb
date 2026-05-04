import { zodResolver } from "@hookform/resolvers/zod";
import { Eye, EyeOff } from "lucide-react";
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
    },
  });

  // Load existing password from backend when editing
  useEffect(() => {
    if (!editing) return;
    ipc.getConnectionPassword(editing.id).then((pw) => {
      if (pw) form.setValue("password", pw);
    });
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

  async function onSubmit(values: ConnectionFormValues) {
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
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="grid gap-3">
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
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

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

            <FormField
              control={form.control}
              name="database"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-xs font-normal text-muted-foreground">
                    Database
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
                  <FormLabel className="cursor-pointer text-xs font-normal">Require TLS</FormLabel>
                </FormItem>
              )}
            />

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
                            {isNone && <span className="text-[10px] text-muted-foreground">∅</span>}
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

            {submitError && <p className="text-xs text-destructive">{submitError}</p>}

            <DialogFooter className="mt-2">
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={form.formState.isSubmitting}>
                {form.formState.isSubmitting ? "Saving…" : "Save"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
