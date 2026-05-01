import { invoke } from "@tauri-apps/api/core";
import type {
  ConnectionInput,
  Folder,
  FolderInput,
  QueryResult,
  SavedConnection,
} from "../types";

export type SchemaMeta = {
  name: string;
  tables: { name: string; kind: string; columns: { name: string; data_type: string; nullable: boolean }[] }[];
};

export const ipc = {
  runQuery: (connectionId: string, queryId: string, sql: string): Promise<QueryResult> =>
    invoke("run_query", { connectionId, queryId, sql }),

  cancelQuery: (queryId: string): Promise<boolean> =>
    invoke("cancel_query", { queryId }),

  listConnections: (): Promise<SavedConnection[]> => invoke("list_connections"),

  saveConnection: (input: ConnectionInput): Promise<SavedConnection> =>
    invoke("save_connection", { input }),

  deleteConnection: (id: string): Promise<void> =>
    invoke("delete_connection", { id }),

  getConnectionPassword: (id: string): Promise<string | null> =>
    invoke("get_connection_password", { id }),

  disconnect: (id: string): Promise<void> => invoke("disconnect", { id }),

  introspectSchema: (connectionId: string): Promise<SchemaMeta[]> =>
    invoke("introspect_schema", { connectionId }),

  listHistory: (connectionId?: string, limit?: number): Promise<HistoryEntry[]> =>
    invoke("list_history", { connectionId, limit }),

  clearHistory: (connectionId?: string): Promise<void> =>
    invoke("clear_history", { connectionId }),

  listSnippets: (connectionId?: string): Promise<Snippet[]> =>
    invoke("list_snippets", { connectionId }),

  saveSnippet: (input: SnippetInput): Promise<Snippet> =>
    invoke("save_snippet", { input }),

  deleteSnippet: (id: string): Promise<void> =>
    invoke("delete_snippet", { id }),

  getPrimaryKeyColumns: (
    connectionId: string,
    schema: string,
    table: string,
  ): Promise<string[]> => invoke("get_primary_key_columns", { connectionId, schema, table }),

  executeDml: (
    connectionId: string,
    sql: string,
    params: (string | null)[],
  ): Promise<number> => invoke("execute_dml", { connectionId, sql, params }),

  listFolders: (): Promise<Folder[]> => invoke("list_folders"),
  saveFolder: (input: FolderInput): Promise<Folder> => invoke("save_folder", { input }),
  deleteFolder: (id: string): Promise<void> => invoke("delete_folder", { id }),
};

export type HistoryEntry = {
  id: number;
  connection_id: string;
  sql: string;
  executed_at: string;
  elapsed_ms: number | null;
  row_count: number | null;
  error: string | null;
};

export type Snippet = {
  id: string;
  connection_id: string | null;
  name: string;
  sql: string;
  created_at: string;
};

export type SnippetInput = {
  id?: string;
  connection_id?: string | null;
  name: string;
  sql: string;
};
