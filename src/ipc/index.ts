import { invoke } from "@tauri-apps/api/core";
import type {
  ConnectionInput,
  DbKind,
  Folder,
  FolderInput,
  QueryResult,
  SavedConnection,
} from "../types";

export type SchemaMeta = {
  name: string;
  tables: {
    name: string;
    kind: string;
    columns: { name: string; data_type: string; nullable: boolean }[];
  }[];
};

export const ipc = {
  runQuery: (connectionId: string, queryId: string, sql: string): Promise<QueryResult> =>
    invoke("run_query", { connectionId, queryId, sql }),

  cancelQuery: (queryId: string): Promise<boolean> => invoke("cancel_query", { queryId }),

  listConnections: (): Promise<SavedConnection[]> => invoke("list_connections"),

  saveConnection: (input: ConnectionInput): Promise<SavedConnection> =>
    invoke("save_connection", { input }),

  deleteConnection: (id: string): Promise<void> => invoke("delete_connection", { id }),

  getConnectionPassword: (id: string): Promise<string | null> =>
    invoke("get_connection_password", { id }),

  getConnectionWgConfig: (id: string): Promise<string | null> =>
    invoke("get_connection_wg_config", { id }),

  readTextFile: (path: string): Promise<string> => invoke("read_text_file", { path }),

  disconnect: (id: string): Promise<void> => invoke("disconnect", { id }),

  listActiveConnections: (): Promise<string[]> => invoke("list_active_connections"),

  introspectSchema: (connectionId: string): Promise<SchemaMeta[]> =>
    invoke("introspect_schema", { connectionId }),

  listDatabases: (connectionId: string): Promise<string[]> =>
    invoke("list_databases", { connectionId }),

  createDatabase: (connectionId: string, name: string): Promise<void> =>
    invoke("create_database", { connectionId, name }),

  dropDatabase: (connectionId: string, name: string): Promise<void> =>
    invoke("drop_database", { connectionId, name }),

  listHistory: (connectionId?: string, limit?: number): Promise<HistoryEntry[]> =>
    invoke("list_history", { connectionId, limit }),

  clearHistory: (connectionId?: string): Promise<void> => invoke("clear_history", { connectionId }),

  listSnippets: (connectionId?: string): Promise<Snippet[]> =>
    invoke("list_snippets", { connectionId }),

  saveSnippet: (input: SnippetInput): Promise<Snippet> => invoke("save_snippet", { input }),

  deleteSnippet: (id: string): Promise<void> => invoke("delete_snippet", { id }),

  getPrimaryKeyColumns: (connectionId: string, schema: string, table: string): Promise<string[]> =>
    invoke("get_primary_key_columns", { connectionId, schema, table }),

  executeDml: (connectionId: string, sql: string, params: (string | null)[]): Promise<number> =>
    invoke("execute_dml", { connectionId, sql, params }),

  listFolders: (): Promise<Folder[]> => invoke("list_folders"),
  saveFolder: (input: FolderInput): Promise<Folder> => invoke("save_folder", { input }),
  deleteFolder: (id: string): Promise<void> => invoke("delete_folder", { id }),

  exportDatabase: (
    connectionId: string,
    options: ExportOptions,
    outputPath: string,
  ): Promise<ExportSummary> => invoke("export_database", { connectionId, options, outputPath }),

  importSql: (
    connectionId: string,
    inputPath: string,
    options: ImportOptions,
  ): Promise<ImportSummary> => invoke("import_sql", { connectionId, inputPath, options }),

  checkDumpTools: (kind: DbKind): Promise<ToolStatus> => invoke("check_dump_tools", { kind }),

  cancelDump: (jobId: string): Promise<boolean> => invoke("cancel_dump", { jobId }),

  pickSavePath: (defaultFilename?: string): Promise<string | null> =>
    invoke("pick_save_path", { defaultFilename }),

  pickOpenPath: (): Promise<string | null> => invoke("pick_open_path"),

  pickWgConfPath: (): Promise<string | null> => invoke("pick_wg_conf_path"),

  pickSqlitePath: (): Promise<string | null> => invoke("pick_sqlite_path"),

  getSettings: (): Promise<AppSettings> => invoke("get_settings"),
  saveSettings: (settings: AppSettings): Promise<AppSettings> =>
    invoke("save_settings", { settings }),
};

export type DumpEngine = "tool" | "native";

export type TableRef = { schema: string; table: string };

export type ExportOptions = {
  engine: DumpEngine;
  include_schema: boolean;
  include_data: boolean;
  tables: TableRef[] | null;
  job_id: string;
};

export type ImportOptions = {
  engine: DumpEngine;
  single_transaction: boolean;
  job_id: string;
};

export type ExportSummary = {
  bytes_written: number;
  tables_dumped: number;
};

export type ImportSummary = {
  statements_executed: number;
};

export type ToolStatus = {
  dump: string | null;
  client: string | null;
};

export type DumpProgressEvent = {
  job_id: string;
  phase: string;
  table: string | null;
  rows_done: number | null;
  statements_done: number | null;
  message: string | null;
};

export type AppSettings = {
  pg_dump_path: string | null;
  mysqldump_path: string | null;
  psql_path: string | null;
  mysql_path: string | null;
  sqlite3_path: string | null;
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
