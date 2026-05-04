export type DbKind = "postgres" | "mysql";

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
};

export type ConnectionInput = Omit<SavedConnection, "id" | "folder_id" | "color"> & {
  id?: string;
  password?: string;
  folder_id?: string | null;
  color?: string | null;
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
