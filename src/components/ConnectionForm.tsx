import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useConnections } from "../stores/connections";
import type { ConnectionInput, DbKind, SavedConnection } from "../types";
import { folderPaths } from "../utils/folderTree";

type Props = {
  editingId: string | null;
  initialFolderId?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

const DEFAULTS: Record<DbKind, { port: number; database: string; username: string }> = {
  postgres: { port: 5432, database: "postgres", username: "postgres" },
  mysql: { port: 3306, database: "", username: "root" },
};

const ROOT = "__root__";

export function ConnectionForm({ editingId, initialFolderId, open, onOpenChange }: Props) {
  const { connections, folders, save } = useConnections();
  const editing: SavedConnection | undefined = connections.find((c) => c.id === editingId);

  const [name, setName] = useState(editing?.name ?? "Local Postgres");
  const [kind, setKind] = useState<DbKind>(editing?.kind ?? "postgres");
  const [host, setHost] = useState(editing?.host ?? "localhost");
  const [port, setPort] = useState<number>(editing?.port ?? DEFAULTS.postgres.port);
  const [database, setDatabase] = useState(editing?.database ?? DEFAULTS.postgres.database);
  const [username, setUsername] = useState(editing?.username ?? DEFAULTS.postgres.username);
  const [password, setPassword] = useState("");
  const [ssl, setSsl] = useState(editing?.ssl ?? false);
  const [folderId, setFolderId] = useState<string>(
    editing?.folder_id ?? initialFolderId ?? "",
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const paths = folderPaths(folders);

  useEffect(() => {
    if (!editing) {
      const d = DEFAULTS[kind];
      setPort(d.port);
      if (!database) setDatabase(d.database);
      if (!username || username === "postgres" || username === "root") setUsername(d.username);
    }
  }, [kind]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const input: ConnectionInput = {
        id: editing?.id,
        name,
        kind,
        host,
        port: Number(port),
        database,
        username,
        ssl,
        folder_id: folderId === ROOT || !folderId ? null : folderId,
        ...(password ? { password } : {}),
      };
      await save(input);
      onOpenChange(false);
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit connection" : "New connection"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-3">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} required />
          </Field>
          <Field label="Type">
            <Select value={kind} onValueChange={(v) => setKind(v as DbKind)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="postgres">PostgreSQL</SelectItem>
                <SelectItem value="mysql">MySQL / MariaDB</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <div className="grid grid-cols-[2fr_1fr] gap-3">
            <Field label="Host">
              <Input value={host} onChange={(e) => setHost(e.target.value)} required />
            </Field>
            <Field label="Port">
              <Input
                type="number"
                value={port}
                onChange={(e) => setPort(Number(e.target.value))}
                required
              />
            </Field>
          </div>
          <Field label="Database">
            <Input value={database} onChange={(e) => setDatabase(e.target.value)} />
          </Field>
          <Field label="Username">
            <Input value={username} onChange={(e) => setUsername(e.target.value)} required />
          </Field>
          <Field label={editing ? "Password (leave blank to keep current)" : "Password"}>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
            />
          </Field>
          <div className="flex items-center gap-2">
            <Checkbox id="ssl" checked={ssl} onCheckedChange={(v) => setSsl(v === true)} />
            <Label htmlFor="ssl" className="cursor-pointer text-xs font-normal">
              Require TLS
            </Label>
          </div>
          <Field label="Folder">
            <Select
              value={folderId || ROOT}
              onValueChange={(v) => setFolderId(v === ROOT ? "" : v)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ROOT}>(top level)</SelectItem>
                {paths.map((p) => (
                  <SelectItem key={p.folder.id} value={p.folder.id}>
                    {p.path}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          {error && <p className="text-xs text-destructive">{error}</p>}

          <DialogFooter className="mt-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Label className="text-xs font-normal text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}
