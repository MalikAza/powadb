import {
  File,
  FileArchive,
  FileAudio,
  FileCode2,
  FileImage,
  FileJson,
  FileSpreadsheet,
  FileText,
  FileVideo,
  type LucideIcon,
} from "lucide-react";

/** Coarse object category, used for both the row icon and the type filter. */
export type FileCategory =
  | "image"
  | "pdf"
  | "archive"
  | "audio"
  | "video"
  | "code"
  | "spreadsheet"
  | "text"
  | "other";

/** Human label for a category, shown in the type-filter control. */
export const CATEGORY_LABEL: Record<FileCategory, string> = {
  image: "Images",
  pdf: "PDF",
  archive: "Archives",
  audio: "Audio",
  video: "Video",
  code: "Code",
  spreadsheet: "Spreadsheets",
  text: "Text",
  other: "Other",
};

/** The order categories appear in the filter control. */
export const CATEGORY_ORDER: FileCategory[] = [
  "image",
  "pdf",
  "archive",
  "audio",
  "video",
  "code",
  "spreadsheet",
  "text",
  "other",
];

// Extension → category. Extensions are matched lowercase, without the dot.
const EXT_CATEGORY: Record<string, FileCategory> = {
  // images
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  bmp: "image",
  ico: "image",
  svg: "image",
  avif: "image",
  tiff: "image",
  // pdf
  pdf: "pdf",
  // archives
  zip: "archive",
  tar: "archive",
  gz: "archive",
  tgz: "archive",
  bz2: "archive",
  xz: "archive",
  rar: "archive",
  "7z": "archive",
  // audio
  mp3: "audio",
  wav: "audio",
  flac: "audio",
  ogg: "audio",
  m4a: "audio",
  aac: "audio",
  // video
  mp4: "video",
  webm: "video",
  mov: "video",
  mkv: "video",
  avi: "video",
  m4v: "video",
  // spreadsheets
  csv: "spreadsheet",
  tsv: "spreadsheet",
  xls: "spreadsheet",
  xlsx: "spreadsheet",
  // code
  js: "code",
  jsx: "code",
  ts: "code",
  tsx: "code",
  json: "code",
  yaml: "code",
  yml: "code",
  toml: "code",
  rs: "code",
  py: "code",
  go: "code",
  rb: "code",
  java: "code",
  c: "code",
  h: "code",
  cpp: "code",
  cs: "code",
  php: "code",
  sh: "code",
  sql: "code",
  html: "code",
  css: "code",
  xml: "code",
  // text
  txt: "text",
  md: "text",
  markdown: "text",
  log: "text",
  ini: "text",
  conf: "text",
};

/** Lowercase file extension of a key (no dot), or `""` when there is none. */
export function fileExtension(key: string): string {
  const name = key.replace(/\/+$/, "").split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  // No extension, or a dotfile like ".gitignore".
  if (dot <= 0) return "";
  return name.slice(dot + 1).toLowerCase();
}

/** Classify an object by its key extension, falling back to its content type. */
export function fileCategory(key: string, contentType?: string | null): FileCategory {
  const byExt = EXT_CATEGORY[fileExtension(key)];
  if (byExt) return byExt;
  const ct = contentType?.toLowerCase() ?? "";
  if (ct.startsWith("image/")) return "image";
  if (ct.startsWith("audio/")) return "audio";
  if (ct.startsWith("video/")) return "video";
  if (ct === "application/pdf") return "pdf";
  if (ct.startsWith("text/")) return "text";
  if (ct.includes("json") || ct.includes("xml") || ct.includes("javascript")) return "code";
  if (ct.includes("zip") || ct.includes("tar") || ct.includes("compressed")) return "archive";
  return "other";
}

const CATEGORY_ICON: Record<FileCategory, LucideIcon> = {
  image: FileImage,
  pdf: FileText,
  archive: FileArchive,
  audio: FileAudio,
  video: FileVideo,
  code: FileCode2,
  spreadsheet: FileSpreadsheet,
  text: FileText,
  other: File,
};

/** Tailwind text-color class per category, to differentiate at a glance. */
const CATEGORY_COLOR: Record<FileCategory, string> = {
  image: "text-purple-500",
  pdf: "text-red-500",
  archive: "text-amber-500",
  audio: "text-pink-500",
  video: "text-blue-500",
  code: "text-emerald-500",
  spreadsheet: "text-green-600",
  text: "text-sky-500",
  other: "text-muted-foreground",
};

/** Icon component for an object, based on its category. */
export function fileIcon(key: string, contentType?: string | null): LucideIcon {
  const cat = fileCategory(key, contentType);
  // JSON gets its own glyph despite being a "code" category.
  if (fileExtension(key) === "json") return FileJson;
  return CATEGORY_ICON[cat];
}

/** Tailwind color class for an object's icon, based on its category. */
export function fileIconColor(key: string, contentType?: string | null): string {
  return CATEGORY_COLOR[fileCategory(key, contentType)];
}
