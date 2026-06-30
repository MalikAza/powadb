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

/// Capability flags returned by `get_capabilities`. Drives feature visibility
/// in the UI — hide the Diagram tab for Mongo, hide CREATE DATABASE for
/// SQLite, hide PostGIS handling outside Postgres, etc.
export type QueryLanguage = "sql" | "mongo" | "none";

export type Capabilities = {
  supports_databases_list: boolean;
  supports_database_create: boolean;
  supports_database_drop: boolean;
  supports_schemas: boolean;
  supports_foreign_keys: boolean;
  supports_ddl_diff: boolean;
  supports_diagram: boolean;
  supports_geo: boolean;
  supports_native_dump: boolean;
  query_language: QueryLanguage;
};

/// MongoDB operations the frontend can issue via `runEngineQuery`. Mirrors
/// the Rust `MongoOp` enum (serde tag = "op", snake_case). For exploration
/// we accept structured ops; a future `mongosh`-style DSL parser would emit
/// these from `db.users.find({...}).limit(10)` etc.
export type MongoOp =
  | {
      op: "find";
      collection: string;
      database?: string;
      filter?: unknown;
      projection?: unknown;
      limit?: number;
      skip?: number;
      sort?: unknown;
    }
  | {
      op: "find_one";
      collection: string;
      database?: string;
      filter?: unknown;
      projection?: unknown;
    }
  | { op: "aggregate"; collection: string; database?: string; pipeline: unknown[] }
  | { op: "insert_one"; collection: string; database?: string; document: unknown }
  | { op: "insert_many"; collection: string; database?: string; documents: unknown[] }
  | {
      op: "update_one";
      collection: string;
      database?: string;
      filter: unknown;
      update: unknown;
    }
  | {
      op: "update_many";
      collection: string;
      database?: string;
      filter: unknown;
      update: unknown;
    }
  | { op: "delete_one"; collection: string; database?: string; filter: unknown }
  | { op: "delete_many"; collection: string; database?: string; filter: unknown }
  | { op: "run_command"; value: unknown };

/// Engine-agnostic query input. SQL engines accept `{ kind: "sql", value: "<sql>" }`;
/// Mongo accepts `{ kind: "mongo", value: MongoOp }`.
export type EngineQuery = { kind: "sql"; value: string } | { kind: "mongo"; value: MongoOp };

/// Engine-agnostic result. The variant the frontend sees depends on the
/// engine: SQL → `tabular`, Mongo find/aggregate → `documents`, Mongo writes
/// → `affected`.
export type EngineResult =
  | { kind: "tabular"; columns: unknown[]; rows: unknown[][]; elapsed_ms: number }
  | { kind: "documents"; docs: unknown[]; elapsed_ms: number }
  | { kind: "affected"; rows: number; elapsed_ms: number };

// ─── S3 / object storage ──────────────────────────────────────────────────────

/// A bucket from the account-level listing.
export type S3Bucket = { name: string; creation_date: string | null };

/// One object key in a listing (not a rolled-up folder prefix).
export type S3Object = {
  key: string;
  size: number;
  last_modified: string;
  e_tag: string | null;
  storage_class: string | null;
};

/// One page of a `/`-delimited listing under `prefix`.
export type S3Listing = {
  prefix: string;
  folders: string[];
  objects: S3Object[];
  next_token: string | null;
};

export type S3ObjectMeta = {
  content_type: string | null;
  content_length: number | null;
  last_modified: string | null;
  e_tag: string | null;
  metadata: Record<string, string>;
};

/// Bounded preview of an object. Only the field matching `kind` is populated.
export type S3ObjectPreview = {
  kind: "text" | "image" | "binary";
  content_type: string | null;
  size: number;
  truncated: boolean;
  text: string | null;
  base64: string | null;
};

export type S3DownloadSummary = { bytes: number };

/// Progress event emitted on `s3-download-progress` during a streaming download.
export type S3DownloadProgressEvent = { job_id: string; bytes_done: number };

/// Progress event emitted on `s3-upload-progress` during a streaming upload.
export type S3UploadProgressEvent = { job_id: string; bytes_done: number };

/// Local path of an object downloaded into the preview cache.
export type S3CachedObject = { path: string };

/// One member of an archive (zip) object.
export type S3ArchiveEntry = {
  name: string;
  size: number;
  compressed_size: number;
  is_dir: boolean;
};

export type S3UploadSummary = { bytes: number };
export type S3UploadDirSummary = { bytes: number; files: number };
export type S3DeleteFolderSummary = { deleted: number };
export type S3RenameFolderSummary = { moved: number };

export const ipc = {
  runQuery: (connectionId: string, queryId: string, sql: string): Promise<QueryResult> =>
    invoke("run_query", { connectionId, queryId, sql }),

  runScript: (connectionId: string, queryId: string, sql: string): Promise<ScriptResult> =>
    invoke("run_script", { connectionId, queryId, sql }),

  cancelQuery: (queryId: string): Promise<boolean> => invoke("cancel_query", { queryId }),

  listConnections: (): Promise<SavedConnection[]> => invoke("list_connections"),

  saveConnection: (input: ConnectionInput): Promise<SavedConnection> =>
    invoke("save_connection", { input }),

  deleteConnection: (id: string): Promise<void> => invoke("delete_connection", { id }),

  getConnectionPassword: (id: string): Promise<string | null> =>
    invoke("get_connection_password", { id }),

  getConnectionWgConfig: (id: string): Promise<string | null> =>
    invoke("get_connection_wg_config", { id }),

  getConnectionSshConfig: (id: string): Promise<string | null> =>
    invoke("get_connection_ssh_config", { id }),

  readTextFile: (path: string): Promise<string> => invoke("read_text_file", { path }),

  writeTextFile: (path: string, contents: string): Promise<void> =>
    invoke("write_text_file", { path, contents }),

  writeBinaryFile: (path: string, base64: string): Promise<void> =>
    invoke("write_binary_file", { path, base64 }),

  disconnect: (id: string): Promise<void> => invoke("disconnect", { id }),

  listActiveConnections: (): Promise<string[]> => invoke("list_active_connections"),

  switchDatabase: (connectionId: string, database: string): Promise<void> =>
    invoke("switch_database", { connectionId, database }),

  prewarmConnection: (id: string): Promise<void> => invoke("prewarm_connection", { id }),

  getCapabilities: (connectionId: string): Promise<Capabilities> =>
    invoke("get_capabilities", { connectionId }),

  /// Engine-agnostic query path used for non-SQL engines (currently Mongo).
  /// Takes a `queryId` so Cmd+. / `cancelQuery` can interrupt long-running
  /// Mongo ops the same way it does SQL queries. The backend logs the op to
  /// query history under a JSON one-liner representation.
  runEngineQuery: (
    connectionId: string,
    queryId: string,
    query: EngineQuery,
  ): Promise<EngineResult> => invoke("run_engine_query", { connectionId, queryId, query }),

  introspectSchema: (connectionId: string): Promise<SchemaMeta[]> =>
    invoke("introspect_schema", { connectionId }),

  introspectDiagram: (
    connectionId: string,
    schema?: string | null,
  ): Promise<DiagramIntrospection> =>
    invoke("introspect_diagram", { connectionId, schema: schema ?? null }),

  listForeignKeys: (connectionId: string, schema: string, table: string): Promise<DiagFk[]> =>
    invoke("list_foreign_keys", { connectionId, schema, table }),

  listDiagrams: (connectionId: string): Promise<SavedDiagram[]> =>
    invoke("list_diagrams", { connectionId }),

  getDiagram: (id: string): Promise<SavedDiagram | null> => invoke("get_diagram", { id }),

  saveDiagram: (input: DiagramSaveInput): Promise<SavedDiagram> =>
    invoke("save_diagram", { input }),

  deleteDiagram: (id: string): Promise<void> => invoke("delete_diagram", { id }),

  generateDiagramDdl: (docJson: string, engine: DbKind): Promise<string> =>
    invoke("generate_diagram_ddl_cmd", { docJson, engine }),

  diffDiagram: (connectionId: string, docJson: string): Promise<DiffResult> =>
    invoke("diff_diagram", { connectionId, docJson }),

  generateAlterDdl: (ops: DiffOp[], engine: DbKind): Promise<string> =>
    invoke("generate_alter_ddl_cmd", { ops, engine }),

  executeDdl: (connectionId: string, sql: string): Promise<void> =>
    invoke("execute_ddl", { connectionId, sql }),

  geometryToGeoJSON: (connectionId: string, ewkbHex: string): Promise<string> =>
    invoke("geometry_to_geojson", { connectionId, ewkbHex }),

  geometriesToGeoJSON: (connectionId: string, ewkbHexList: string[]): Promise<(string | null)[]> =>
    invoke("geometries_to_geojson", { connectionId, ewkbHexList }),

  decodeGeometries: (
    connectionId: string,
    ewkbHexList: string[],
  ): Promise<(DecodedGeometry | null)[]> =>
    invoke("decode_geometries", { connectionId, ewkbHexList }),

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

  updateSnippetByteaModes: (id: string, byteaModesJson: string | null): Promise<void> =>
    invoke("update_snippet_bytea_modes", { id, byteaModesJson }),

  listThemes: (): Promise<StoredTheme[]> => invoke("list_themes"),
  saveTheme: (input: ThemeSaveInput): Promise<StoredTheme> => invoke("save_theme", { input }),
  deleteTheme: (id: string): Promise<void> => invoke("delete_theme", { id }),

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

  pickSavePathAny: (defaultFilename?: string): Promise<string | null> =>
    invoke("pick_save_path_any", { defaultFilename }),

  pickSavePathWithFilter: (
    defaultFilename: string | undefined,
    filterLabel: string,
    extensions: string[],
  ): Promise<string | null> =>
    invoke("pick_save_path_with_filter", {
      defaultFilename: defaultFilename ?? null,
      filterLabel,
      extensions,
    }),

  pickOpenPath: (): Promise<string | null> => invoke("pick_open_path"),

  pickOpenPathWithFilter: (filterLabel: string, extensions: string[]): Promise<string | null> =>
    invoke("pick_open_path_with_filter", { filterLabel, extensions }),

  pickAnyFile: (): Promise<string | null> => invoke("pick_any_file"),

  pickDirectory: (): Promise<string | null> => invoke("pick_directory"),

  pickWgConfPath: (): Promise<string | null> => invoke("pick_wg_conf_path"),

  pickSshKeyPath: (): Promise<string | null> => invoke("pick_ssh_key_path"),

  pickSqlitePath: (): Promise<string | null> => invoke("pick_sqlite_path"),

  getSettings: (): Promise<AppSettings> => invoke("get_settings"),
  saveSettings: (settings: AppSettings): Promise<AppSettings> =>
    invoke("save_settings", { settings }),

  openExternal: (url: string): Promise<void> => invoke("open_external", { url }),

  // ─── S3 / object storage ──────────────────────────────────────────────────
  s3ListBuckets: (connectionId: string): Promise<S3Bucket[]> =>
    invoke("s3_list_buckets", { connectionId }),

  s3ListObjects: (
    connectionId: string,
    bucket: string,
    prefix: string,
    continuationToken?: string | null,
  ): Promise<S3Listing> =>
    invoke("s3_list_objects", {
      connectionId,
      bucket,
      prefix,
      continuationToken: continuationToken ?? null,
    }),

  s3ObjectMeta: (connectionId: string, bucket: string, key: string): Promise<S3ObjectMeta> =>
    invoke("s3_object_meta", { connectionId, bucket, key }),

  s3PreviewObject: (
    connectionId: string,
    bucket: string,
    key: string,
    maxBytes?: number,
  ): Promise<S3ObjectPreview> =>
    invoke("s3_preview_object", { connectionId, bucket, key, maxBytes: maxBytes ?? null }),

  s3DownloadObject: (
    connectionId: string,
    bucket: string,
    key: string,
    destPath: string,
    jobId: string,
  ): Promise<S3DownloadSummary> =>
    invoke("s3_download_object", { connectionId, bucket, key, destPath, jobId }),

  s3CacheObject: (connectionId: string, bucket: string, key: string): Promise<S3CachedObject> =>
    invoke("s3_cache_object", { connectionId, bucket, key }),

  s3ArchiveEntries: (
    connectionId: string,
    bucket: string,
    key: string,
  ): Promise<S3ArchiveEntry[]> => invoke("s3_archive_entries", { connectionId, bucket, key }),

  s3PutObject: (
    connectionId: string,
    bucket: string,
    key: string,
    srcPath: string,
    jobId: string,
  ): Promise<S3UploadSummary> =>
    invoke("s3_put_object", { connectionId, bucket, key, srcPath, jobId }),

  s3PutDirectory: (
    connectionId: string,
    bucket: string,
    destPrefix: string,
    srcDir: string,
    jobId: string,
  ): Promise<S3UploadDirSummary> =>
    invoke("s3_put_directory", { connectionId, bucket, destPrefix, srcDir, jobId }),

  s3DeleteObject: (connectionId: string, bucket: string, key: string): Promise<void> =>
    invoke("s3_delete_object", { connectionId, bucket, key }),

  s3DeleteFolder: (
    connectionId: string,
    bucket: string,
    prefix: string,
  ): Promise<S3DeleteFolderSummary> => invoke("s3_delete_folder", { connectionId, bucket, prefix }),

  s3CreateFolder: (connectionId: string, bucket: string, prefix: string): Promise<void> =>
    invoke("s3_create_folder", { connectionId, bucket, prefix }),

  s3RenameObject: (
    connectionId: string,
    bucket: string,
    srcKey: string,
    dstKey: string,
  ): Promise<void> => invoke("s3_rename_object", { connectionId, bucket, srcKey, dstKey }),

  s3RenameFolder: (
    connectionId: string,
    bucket: string,
    srcPrefix: string,
    dstPrefix: string,
  ): Promise<S3RenameFolderSummary> =>
    invoke("s3_rename_folder", { connectionId, bucket, srcPrefix, dstPrefix }),
};

export type ConnState =
  | { kind: "idle" }
  | { kind: "connecting" }
  | { kind: "ready" }
  | { kind: "error"; message: string };

export type ConnStateChangedEvent = {
  connection_id: string;
  state: ConnState;
};

export type StatementResult = {
  index: number;
  sql_excerpt: string;
  elapsed_ms: number;
  rows_affected?: number;
  result?: QueryResult;
  error?: string;
};

export type ScriptResult = {
  statements: StatementResult[];
};

export type DecodedGeometry = {
  geojson: string;
  srid: number;
  geom_type: string;
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
  theme_kind: string | null;
  theme_value: string | null;
};

export type StoredTheme = {
  id: string;
  name: string;
  base: string;
  radius: string;
  colors_json: string;
  created_at: string;
  updated_at: string;
};

export type ThemeSaveInput = {
  id?: string;
  name: string;
  base: string;
  radius: string;
  colors_json: string;
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
  bytea_modes_json: string | null;
};

export type SnippetInput = {
  id?: string;
  connection_id?: string | null;
  name: string;
  sql: string;
  bytea_modes_json?: string | null;
};

export type DiagColumn = {
  name: string;
  data_type: string;
  nullable: boolean;
  is_pk: boolean;
  default: string | null;
  ordinal: number;
  char_max_len: number | null;
  numeric_precision: number | null;
  numeric_scale: number | null;
};

export type DiagTable = {
  schema: string;
  name: string;
  columns: DiagColumn[];
  indexes: DiagIndex[];
};

export type DiagIndex = {
  name: string;
  is_unique: boolean;
  is_primary: boolean;
  columns: string[];
  method: string | null;
};

export type DiagSequence = {
  schema: string;
  name: string;
  data_type: string;
  owned_by_schema: string | null;
  owned_by_table: string | null;
  owned_by_column: string | null;
};

export type DiagFk = {
  id: string;
  name: string | null;
  from_schema: string;
  from_table: string;
  from_columns: string[];
  to_schema: string;
  to_table: string;
  to_columns: string[];
  on_update: string | null;
  on_delete: string | null;
};

export type DiagramIntrospection = {
  tables: DiagTable[];
  foreign_keys: DiagFk[];
  sequences: DiagSequence[];
};

export type SavedDiagram = {
  id: string;
  connection_id: string;
  name: string;
  doc_json: string;
  created_at: string;
  updated_at: string;
};

export type DiagramSaveInput = {
  id?: string;
  connection_id: string;
  name: string;
  doc_json: string;
};

export type OpColumn = {
  name: string;
  data_type: string;
  nullable: boolean;
  is_pk: boolean;
  default_value: string | null;
};

export type DiffOp =
  | { kind: "add_table"; schema: string; name: string; columns: OpColumn[] }
  | { kind: "drop_table"; schema: string; name: string }
  | { kind: "rename_table"; schema: string; from: string; to: string }
  | { kind: "add_column"; schema: string; table: string; column: OpColumn }
  | { kind: "drop_column"; schema: string; table: string; column: string }
  | { kind: "rename_column"; schema: string; table: string; from: string; to: string }
  | { kind: "alter_column_type"; schema: string; table: string; column: string; new_type: string }
  | {
      kind: "alter_column_nullable";
      schema: string;
      table: string;
      column: string;
      nullable: boolean;
    }
  | {
      kind: "alter_column_default";
      schema: string;
      table: string;
      column: string;
      default: string | null;
    }
  | {
      kind: "add_fk";
      schema: string;
      table: string;
      constraint_name: string | null;
      columns: string[];
      target_schema: string;
      target_table: string;
      target_columns: string[];
      on_update: string | null;
      on_delete: string | null;
    }
  | { kind: "drop_fk"; schema: string; table: string; constraint_name: string };

export type DiffResult = { ops: DiffOp[] };

export function diffOpSummary(op: DiffOp): string {
  switch (op.kind) {
    case "add_table":
      return `+ table ${op.schema ? `${op.schema}.` : ""}${op.name}`;
    case "drop_table":
      return `− table ${op.schema ? `${op.schema}.` : ""}${op.name}`;
    case "rename_table":
      return `~ rename table ${op.from} → ${op.to}`;
    case "add_column":
      return `+ column ${op.table}.${op.column.name}`;
    case "drop_column":
      return `− column ${op.table}.${op.column}`;
    case "rename_column":
      return `~ rename column ${op.table}.${op.from} → ${op.to}`;
    case "alter_column_type":
      return `~ ${op.table}.${op.column} type → ${op.new_type}`;
    case "alter_column_nullable":
      return `~ ${op.table}.${op.column} ${op.nullable ? "NULL" : "NOT NULL"}`;
    case "alter_column_default":
      return `~ ${op.table}.${op.column} DEFAULT ${op.default ?? "—"}`;
    case "add_fk":
      return `+ FK ${op.table}(${op.columns.join(",")}) → ${op.target_table}(${op.target_columns.join(",")})`;
    case "drop_fk":
      return `− FK ${op.constraint_name}`;
  }
}
