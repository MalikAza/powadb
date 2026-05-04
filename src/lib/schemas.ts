import { z } from "zod";

export const dbKindSchema = z.enum(["postgres", "mysql"]);
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
  .pipe(z.number().int().min(1, "Port must be ≥ 1").max(65535, "Port must be ≤ 65535"));

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

export const connectionFormSchema = z.object({
  name: z.string().min(1, "Name is required"),
  kind: dbKindSchema,
  host: z.string().min(1, "Host is required"),
  port: portSchema,
  database: z.string(),
  username: z.string().min(1, "Username is required"),
  password: z.string().optional().default(""),
  ssl: z.boolean(),
  folder_id: optionalFolderId,
  color: z.string().nullable().default(null),
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
};
