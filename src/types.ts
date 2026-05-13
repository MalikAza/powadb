export type DbKind = "postgres" | "mysql" | "sqlite";

/// Marker for a connection that has WireGuard enabled. The full `.conf` content
/// is fetched separately (`ipc.getConnectionWgConfig`) so list responses don't
/// expose the private key.
export type WgTunnel = Record<string, never>;

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
};

export type ConnectionInput = Omit<SavedConnection, "id" | "folder_id" | "color" | "wg"> & {
  id?: string;
  password?: string;
  folder_id?: string | null;
  color?: string | null;
  wg_enabled?: boolean;
  /** Raw `wireguard.conf` contents. Omit to leave the stored conf untouched. */
  wg_config?: string;
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
