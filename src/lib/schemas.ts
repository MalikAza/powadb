import { z } from "zod";

export const dbKindSchema = z.enum(["postgres", "mysql", "sqlite"]);
export type DbKindEnum = z.infer<typeof dbKindSchema>;

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

export const KIND_DEFAULTS: Record<
  DbKindEnum,
  { port: number; database: string; username: string }
> = {
  postgres: { port: 5432, database: "postgres", username: "postgres" },
  mysql: { port: 3306, database: "", username: "root" },
  // SQLite is file-based: host/port/username are unused; `database` holds the file path.
  sqlite: { port: 0, database: "", username: "" },
};
