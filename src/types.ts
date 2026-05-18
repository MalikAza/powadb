import type { z } from "zod";
import type { dbKindSchema } from "./lib/schemas";

export type DbKind = z.infer<typeof dbKindSchema>;

/// Marker for a connection that has WireGuard enabled. The full `.conf` content
/// is fetched separately (`ipc.getConnectionWgConfig`) so list responses don't
/// expose the private key.
export type WgTunnel = Record<string, never>;

/// Marker for a connection that has an SSH tunnel enabled. The full config
/// (host, username, key/passphrase, host fingerprint) is fetched separately
/// via `ipc.getConnectionSshConfig`.
export type SshTunnel = Record<string, never>;

export type SavedConnection = {
  id: string;
  name: string;
  kind: DbKind;
  host: string;
  port: number;
  database: string;
  username: string;
  ssl: boolean;
  folder_id: string | null;
  color: string | null;
  wg: WgTunnel | null;
  ssh: SshTunnel | null;
};

export type ConnectionInput = Omit<SavedConnection, "id" | "folder_id" | "color" | "wg" | "ssh"> & {
  id?: string;
  password?: string;
  folder_id?: string | null;
  color?: string | null;
  wg_enabled?: boolean;
  /** Raw `wireguard.conf` contents. Omit to leave the stored conf untouched. */
  wg_config?: string;
  ssh_enabled?: boolean;
  /** JSON-serialized SshConfig. Omit to leave the stored config untouched. */
  ssh_config?: string;
};

/// Mirrors `crate::ssh::config::SshConfig` on the Rust side. Serialized into
/// `ssh_config` (JSON string) when the form is submitted.
export type SshConfigPayload = {
  host: string;
  port: number;
  username: string;
  auth:
    | { kind: "password"; password: string }
    | { kind: "private_key"; path: string; passphrase?: string | null };
  known_host_fingerprint?: string | null;
};

export type Folder = {
  id: string;
  name: string;
  parent_id: string | null;
};

export type FolderInput = {
  id?: string;
  name: string;
  parent_id?: string | null;
};

export type Column = {
  name: string;
  type_name: string;
};

export type QueryResult = {
  columns: Column[];
  rows: unknown[][];
  elapsed_ms: number;
};
