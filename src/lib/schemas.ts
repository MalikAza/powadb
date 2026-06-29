import { z } from "zod";
import type { DbKind } from "@/types";

export const dbKindSchema = z.enum(["postgres", "mysql", "sqlite", "mongo", "s3"]);

export const themeModeSchema = z.enum(["light", "dark", "system"]);
export type ThemeModeEnum = z.infer<typeof themeModeSchema>;

export const ROOT_FOLDER_SENTINEL = "__root__";

const optionalFolderId = z
  .string()
  .nullable()
  .transform((v) => (v === ROOT_FOLDER_SENTINEL ? null : v));

const portSchema = z
  .union([z.string(), z.number()])
  .transform((v) => (typeof v === "string" ? Number(v) : v))
  .pipe(z.number().int().min(0).max(65535));

export const CONNECTION_COLORS = [
  { name: "none", value: null, swatch: "transparent" },
  { name: "slate", value: "#64748b", swatch: "#64748b" },
  { name: "red", value: "#ef4444", swatch: "#ef4444" },
  { name: "orange", value: "#f97316", swatch: "#f97316" },
  { name: "amber", value: "#f59e0b", swatch: "#f59e0b" },
  { name: "green", value: "#22c55e", swatch: "#22c55e" },
  { name: "teal", value: "#14b8a6", swatch: "#14b8a6" },
  { name: "blue", value: "#3b82f6", swatch: "#3b82f6" },
  { name: "violet", value: "#8b5cf6", swatch: "#8b5cf6" },
  { name: "pink", value: "#ec4899", swatch: "#ec4899" },
] as const;

export const sshAuthMethodSchema = z.enum(["key", "password"]);
export type SshAuthMethodEnum = z.infer<typeof sshAuthMethodSchema>;

export const connectionFormSchema = z
  .object({
    name: z.string().min(1, "Name is required"),
    kind: dbKindSchema,
    host: z.string(),
    port: portSchema,
    database: z.string(),
    username: z.string(),
    password: z.string().optional().default(""),
    ssl: z.boolean(),
    folder_id: optionalFolderId,
    color: z.string().nullable().default(null),
    wg_enabled: z.boolean().default(false),
    wg_config: z.string().optional().default(""),
    ssh_enabled: z.boolean().default(false),
    ssh_host: z.string().optional().default(""),
    ssh_port: portSchema.optional().default(22),
    ssh_username: z.string().optional().default(""),
    ssh_auth_method: sshAuthMethodSchema.default("key"),
    ssh_password: z.string().optional().default(""),
    ssh_key_path: z.string().optional().default(""),
    ssh_passphrase: z.string().optional().default(""),
    ssh_known_host_fingerprint: z.string().nullable().default(null),
  })
  .superRefine((v, ctx) => {
    if (v.kind === "sqlite") {
      if (v.database.trim() === "") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["database"],
          message: "Database file path is required",
        });
      }
      return;
    }
    if (v.kind === "mongo") {
      // Mongo accepts either a full URI in the database field or host+port.
      // Skip host/port validation when the database looks like a URI.
      const looksLikeUri =
        v.database.startsWith("mongodb://") || v.database.startsWith("mongodb+srv://");
      if (looksLikeUri) return;
    }
    if (v.host.trim() === "") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["host"],
        message: "Host is required",
      });
    }
    if (v.port < 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["port"],
        message: "Port must be ≥ 1",
      });
    }
    if (v.username.trim() === "") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["username"],
        message: "Username is required",
      });
    }
    if (v.wg_enabled && v.ssh_enabled) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ssh_enabled"],
        message: "Choose either WireGuard or SSH, not both",
      });
    }
    if (v.wg_enabled) {
      if (v.wg_config.trim() === "") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["wg_config"],
          message: "Paste your wireguard.conf contents",
        });
      } else if (!v.wg_config.includes("[Interface]") || !v.wg_config.includes("[Peer]")) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["wg_config"],
          message: "Expected both [Interface] and [Peer] sections",
        });
      }
    }
    if (v.ssh_enabled) {
      if (v.ssh_host.trim() === "") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["ssh_host"],
          message: "SSH host is required",
        });
      }
      if (v.ssh_username.trim() === "") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["ssh_username"],
          message: "SSH username is required",
        });
      }
      if (v.ssh_port < 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["ssh_port"],
          message: "Port must be ≥ 1",
        });
      }
      if (v.ssh_auth_method === "password") {
        if (v.ssh_password === "") {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["ssh_password"],
            message: "SSH password is required",
          });
        }
      } else if (v.ssh_key_path.trim() === "") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["ssh_key_path"],
          message: "Select a private key file",
        });
      }
    }
  });

export type ConnectionFormValues = z.infer<typeof connectionFormSchema>;
export type ConnectionFormInput = z.input<typeof connectionFormSchema>;

export const folderFormSchema = z.object({
  name: z.string().min(1, "Name is required"),
  parent_id: optionalFolderId,
});

export type FolderFormValues = z.infer<typeof folderFormSchema>;
export type FolderFormInput = z.input<typeof folderFormSchema>;

export const snippetSaveSchema = z.object({
  name: z.string().min(1, "Name is required"),
  scope: z.enum(["connection", "global"]),
});

export type SnippetSaveValues = z.infer<typeof snippetSaveSchema>;

/** Parsed shape of `themes.colors_json`. Per-token coverage is enforced by the
 * caller (which falls back to preset defaults for missing keys); the schema
 * just guarantees the JSON is a string→string map. */
export const themeColorsJsonSchema = z.record(z.string(), z.string());
export type ThemeColorsJson = z.infer<typeof themeColorsJsonSchema>;

export const diagramColumnSchema = z.object({
  id: z.string(),
  name: z.string().min(1, "Column name is required"),
  originalName: z.string().optional(),
  dataType: z.string().min(1, "Type is required"),
  nullable: z.boolean(),
  isPk: z.boolean(),
  isFk: z.boolean(),
  defaultValue: z.string().nullable().default(null),
});

export const diagramTableSchema = z.object({
  id: z.string(),
  schema: z.string(),
  name: z.string().min(1, "Table name is required"),
  originalName: z.string().optional(),
  columns: z.array(diagramColumnSchema).min(1, "At least one column is required"),
  position: z.object({ x: z.number(), y: z.number() }),
});

export const diagramEdgeSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  source: z.string(),
  target: z.string(),
  sourceColumns: z.array(z.string()).min(1),
  targetColumns: z.array(z.string()).min(1),
  onUpdate: z.string().nullable(),
  onDelete: z.string().nullable(),
});

export const diagramDocSchema = z.object({
  version: z.literal(1),
  engine: dbKindSchema,
  tables: z.array(diagramTableSchema),
  edges: z.array(diagramEdgeSchema),
});

export type DiagramColumnValues = z.infer<typeof diagramColumnSchema>;
export type DiagramTableValues = z.infer<typeof diagramTableSchema>;
export type DiagramEdgeValues = z.infer<typeof diagramEdgeSchema>;
export type DiagramDocValues = z.infer<typeof diagramDocSchema>;

export const newTableFormSchema = z
  .object({
    name: z.string().min(1, "Table name is required"),
    columns: z
      .array(
        z.object({
          // Carried through the form so edits preserve column identity and
          // original-name tracking for diff/rename detection.
          id: z.string().optional(),
          originalName: z.string().optional(),
          name: z.string().min(1, "Column name is required"),
          dataType: z.string().min(1, "Type is required"),
          nullable: z.boolean(),
          isPk: z.boolean(),
          defaultValue: z.string(),
        }),
      )
      .min(1, "At least one column is required"),
  })
  .superRefine((v, ctx) => {
    if (!v.columns.some((c) => c.isPk)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["columns"],
        message: "Mark at least one column as primary key",
      });
    }
    const seen = new Set<string>();
    v.columns.forEach((c, i) => {
      const key = c.name.trim().toLowerCase();
      if (key && seen.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["columns", i, "name"],
          message: "Duplicate column name",
        });
      }
      seen.add(key);
    });
  });

export type NewTableFormValues = z.infer<typeof newTableFormSchema>;

export const KIND_DEFAULTS: Record<DbKind, { port: number; database: string; username: string }> = {
  postgres: { port: 5432, database: "", username: "postgres" },
  mysql: { port: 3306, database: "", username: "root" },
  // SQLite is file-based: host/port/username are unused; `database` holds the file path.
  sqlite: { port: 0, database: "", username: "" },
  // Mongo: `database` may hold a full mongodb:// or mongodb+srv:// URI, in
  // which case host/port/username are ignored.
  mongo: { port: 27017, database: "", username: "" },
  // S3 object store: `host` is the endpoint host, `port` the endpoint port,
  // `username` the access key, `database` the region. Validated through the
  // generic host/port/username path (endpoint + access key required).
  s3: { port: 443, database: "", username: "" },
};
