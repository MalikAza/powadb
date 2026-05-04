import { z } from "zod";

export const dbKindSchema = z.enum(["postgres", "mysql"]);
export type DbKindEnum = z.infer<typeof dbKindSchema>;

export const ROOT_FOLDER_SENTINEL = "__root__";

const optionalFolderId = z
  .string()
  .nullable()
  .transform((v) => (v === ROOT_FOLDER_SENTINEL ? null : v));

const portSchema = z
  .union([z.string(), z.number()])
  .transform((v) => (typeof v === "string" ? Number(v) : v))
  .pipe(z.number().int().min(1, "Port must be ≥ 1").max(65535, "Port must be ≤ 65535"));

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
