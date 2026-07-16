import { convertFileSrc } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  Download,
  Filter,
  Folder,
  FolderPlus,
  FolderUp,
  Pencil,
  RefreshCw,
  Search,
  Trash2,
  Upload,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import {
  ipc,
  type S3ArchiveEntry,
  type S3DownloadProgressEvent,
  type S3Listing,
  type S3Object,
  type S3ObjectMeta,
  type S3ObjectPreview,
  type S3UploadProgressEvent,
} from "@/ipc";
import {
  CATEGORY_LABEL,
  CATEGORY_ORDER,
  type FileCategory,
  fileCategory,
  fileExtension,
  fileIcon,
  fileIconColor,
} from "@/lib/fileIcons";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";
import { usePanelLayouts } from "@/stores/panelLayouts";
import { type ObjectBrowserTab, useTabs } from "@/stores/tabs";
import type { SavedConnection } from "@/types";

type Props = { tab: ObjectBrowserTab; conn: SavedConnection };

type SortKey = "name" | "size" | "modified";
type SortDir = "asc" | "desc";

/** Format an S3 timestamp string to the user's locale; `—` when unparseable. */
function formatDate(s: string | null | undefined): string {
  if (!s) return "—";
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

/** Last path segment of an object key (the file name), stripped of trailing `/`. */
function basename(key: string): string {
  return key.replace(/\/+$/, "").split("/").pop() ?? key;
}

/** Last segment of a local filesystem path (handles `/` and `\`). */
function localBasename(path: string): string {
  return path.split(/[/\\]/).pop() ?? path;
}

/** Display name of a folder prefix relative to the current prefix. */
function folderName(folderPrefix: string, currentPrefix: string): string {
  const rel = folderPrefix.startsWith(currentPrefix)
    ? folderPrefix.slice(currentPrefix.length)
    : folderPrefix;
  return rel.replace(/\/+$/, "");
}

export function ObjectBrowserPane({ tab, conn }: Props) {
  const patchTab = useTabs((s) => s.patchTab);
  const { bucket, prefix, selectedKey } = tab;

  const savedLayout = usePanelLayouts((s) => s.layouts["object-browser"]);
  const setLayout = usePanelLayouts((s) => s.setLayout);

  const [listing, setListing] = useState<S3Listing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ meta: S3ObjectMeta; body: S3ObjectPreview } | null>(
    null,
  );
  const [previewLoading, setPreviewLoading] = useState(false);
  const [downloadingKey, setDownloadingKey] = useState<string | null>(null);

  // Toolbar state (client-side over the loaded folder).
  const [search, setSearch] = useState("");
  const [activeCategories, setActiveCategories] = useState<Set<FileCategory>>(new Set());
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  // Mutation dialogs.
  const [confirm, setConfirm] = useState<{
    title: string;
    description: string;
    action: () => void;
  } | null>(null);
  const [textDialog, setTextDialog] = useState<{
    kind: "rename" | "renameFolder" | "newFolder";
    value: string;
    original?: string;
  } | null>(null);

  const load = useCallback(
    async (token?: string | null) => {
      setLoading(true);
      setError(null);
      try {
        const page = await ipc.s3ListObjects(conn.id, bucket, prefix, token ?? null);
        setListing((prev) =>
          token && prev
            ? {
                ...page,
                folders: [...prev.folders, ...page.folders],
                objects: [...prev.objects, ...page.objects],
              }
            : page,
        );
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
      }
    },
    [conn.id, bucket, prefix],
  );

  // Clear the previous folder's view synchronously when the browse target
  // (connection / bucket / prefix) changes, so its contents don't flash under
  // the new breadcrumb. Adjusting state during render — per the React docs —
  // rather than in an effect, which would commit a stale frame first.
  const targetKey = `${conn.id} ${bucket} ${prefix}`;
  const [renderedTarget, setRenderedTarget] = useState(targetKey);
  if (renderedTarget !== targetKey) {
    setRenderedTarget(targetKey);
    setListing(null);
    setPreview(null);
    setSearch("");
  }

  // Fetch the first page whenever the browse target changes (`load` is
  // memoized on the same connection/bucket/prefix inputs as `targetKey`).
  useEffect(() => {
    void load();
  }, [load]);

  function navigateTo(nextPrefix: string) {
    patchTab(tab.id, { prefix: nextPrefix, selectedKey: null });
  }

  async function selectObject(key: string) {
    patchTab(tab.id, { selectedKey: key });
    setPreviewLoading(true);
    setPreview(null);
    try {
      const [meta, body] = await Promise.all([
        ipc.s3ObjectMeta(conn.id, bucket, key),
        ipc.s3PreviewObject(conn.id, bucket, key),
      ]);
      setPreview({ meta, body });
    } catch (e) {
      toast.error(`Preview failed: ${e}`);
    } finally {
      setPreviewLoading(false);
    }
  }

  async function download(key: string) {
    const dest = await ipc.pickSavePathAny(basename(key));
    if (!dest) return;
    const jobId = `s3dl-${tab.id}-${key}`;
    setDownloadingKey(key);
    const toastId = toast.loading(`Downloading ${basename(key)}…`);
    let unlisten: UnlistenFn | null = null;
    try {
      unlisten = await listen<S3DownloadProgressEvent>("s3-download-progress", (e) => {
        if (e.payload.job_id === jobId) {
          toast.loading(`Downloading ${basename(key)}… ${formatBytes(e.payload.bytes_done)}`, {
            id: toastId,
          });
        }
      });
      const res = await ipc.s3DownloadObject(conn.id, bucket, key, dest, jobId);
      toast.success(`Saved ${formatBytes(res.bytes)} to ${dest}`, { id: toastId });
    } catch (e) {
      toast.error(`Download failed: ${e}`, { id: toastId });
    } finally {
      unlisten?.();
      setDownloadingKey(null);
    }
  }

  const handleUpload = useCallback(async () => {
    const src = await ipc.pickAnyFile();
    if (!src) return;
    const name = localBasename(src);
    const key = `${prefix}${name}`;
    const run = async () => {
      const jobId = `s3up-${tab.id}-${key}`;
      const toastId = toast.loading(`Uploading ${name}…`);
      let unlisten: UnlistenFn | null = null;
      try {
        unlisten = await listen<S3UploadProgressEvent>("s3-upload-progress", (e) => {
          if (e.payload.job_id === jobId) {
            toast.loading(`Uploading ${name}… ${formatBytes(e.payload.bytes_done)}`, {
              id: toastId,
            });
          }
        });
        const res = await ipc.s3PutObject(conn.id, bucket, key, src, jobId);
        toast.success(`Uploaded ${formatBytes(res.bytes)} → ${name}`, { id: toastId });
        await load();
      } catch (e) {
        toast.error(`Upload failed: ${e}`, { id: toastId });
      } finally {
        unlisten?.();
      }
    };
    if (listing?.objects.some((o) => o.key === key)) {
      setConfirm({
        title: "Overwrite object?",
        description: `“${name}” already exists in this folder and will be replaced.`,
        action: () => void run(),
      });
    } else {
      await run();
    }
  }, [conn.id, bucket, prefix, tab.id, listing, load]);

  const handleUploadDir = useCallback(async () => {
    const dir = await ipc.pickDirectory();
    if (!dir) return;
    const name = localBasename(dir);
    const destPrefix = `${prefix}${name}/`;
    const jobId = `s3updir-${tab.id}-${destPrefix}`;
    const toastId = toast.loading(`Uploading ${name}/…`);
    let unlisten: UnlistenFn | null = null;
    try {
      unlisten = await listen<S3UploadProgressEvent>("s3-upload-progress", (e) => {
        if (e.payload.job_id === jobId) {
          toast.loading(`Uploading ${name}/… ${formatBytes(e.payload.bytes_done)}`, {
            id: toastId,
          });
        }
      });
      const res = await ipc.s3PutDirectory(conn.id, bucket, destPrefix, dir, jobId);
      toast.success(
        `Uploaded ${res.files} file${res.files === 1 ? "" : "s"} (${formatBytes(res.bytes)}) → ${name}/`,
        { id: toastId },
      );
      await load();
    } catch (e) {
      toast.error(`Folder upload failed: ${e}`, { id: toastId });
    } finally {
      unlisten?.();
    }
  }, [conn.id, bucket, prefix, tab.id, load]);

  const refresh = useCallback(() => void load(), [load]);

  // The command palette dispatches these for the active object browser.
  useEffect(() => {
    const onRefresh = () => refresh();
    const onUpload = () => void handleUpload();
    window.addEventListener("s3-refresh", onRefresh);
    window.addEventListener("s3-upload-request", onUpload);
    return () => {
      window.removeEventListener("s3-refresh", onRefresh);
      window.removeEventListener("s3-upload-request", onUpload);
    };
  }, [refresh, handleUpload]);

  function createFolder(name: string) {
    const clean = name.trim().replace(/^\/+|\/+$/g, "");
    if (!clean) return;
    const folderPrefix = `${prefix}${clean}/`;
    void (async () => {
      try {
        await ipc.s3CreateFolder(conn.id, bucket, folderPrefix);
        toast.success(`Created folder ${clean}/`);
        await load();
      } catch (e) {
        toast.error(`Create folder failed: ${e}`);
      }
    })();
  }

  function renameObject(srcKey: string, name: string) {
    const clean = name.trim();
    if (!clean || clean === basename(srcKey)) return;
    const dstKey = `${prefix}${clean}`;
    void (async () => {
      try {
        await ipc.s3RenameObject(conn.id, bucket, srcKey, dstKey);
        toast.success(`Renamed to ${clean}`);
        if (selectedKey === srcKey) patchTab(tab.id, { selectedKey: null });
        await load();
      } catch (e) {
        toast.error(`Rename failed: ${e}`);
      }
    })();
  }

  function renameFolder(srcPrefix: string, name: string) {
    const clean = name.trim().replace(/^\/+|\/+$/g, "");
    if (!clean || clean === folderName(srcPrefix, prefix)) return;
    const dstPrefix = `${prefix}${clean}/`;
    void (async () => {
      try {
        const { moved } = await ipc.s3RenameFolder(conn.id, bucket, srcPrefix, dstPrefix);
        toast.success(`Moved ${moved} object${moved === 1 ? "" : "s"} → ${clean}/`);
        await load();
      } catch (e) {
        toast.error(`Rename folder failed: ${e}`);
      }
    })();
  }

  function deleteObject(key: string) {
    void (async () => {
      try {
        await ipc.s3DeleteObject(conn.id, bucket, key);
        toast.success(`Deleted ${basename(key)}`);
        if (selectedKey === key) patchTab(tab.id, { selectedKey: null });
        await load();
      } catch (e) {
        toast.error(`Delete failed: ${e}`);
      }
    })();
  }

  function deleteFolder(folderPrefix: string) {
    void (async () => {
      try {
        const { deleted } = await ipc.s3DeleteFolder(conn.id, bucket, folderPrefix);
        toast.success(`Deleted ${deleted} object${deleted === 1 ? "" : "s"}`);
        await load();
      } catch (e) {
        toast.error(`Delete folder failed: ${e}`);
      }
    })();
  }

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  function toggleCategory(cat: FileCategory) {
    setActiveCategories((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  }

  // Categories actually present in the current folder, for the filter menu.
  const presentCategories = useMemo(() => {
    const set = new Set<FileCategory>();
    for (const o of listing?.objects ?? []) set.add(fileCategory(o.key));
    return CATEGORY_ORDER.filter((c) => set.has(c));
  }, [listing]);

  const displayedFolders = useMemo(() => {
    const q = search.trim().toLowerCase();
    const folders = (listing?.folders ?? []).filter(
      (f) => !q || folderName(f, prefix).toLowerCase().includes(q),
    );
    folders.sort((a, b) => folderName(a, prefix).localeCompare(folderName(b, prefix)));
    if (sortKey === "name" && sortDir === "desc") folders.reverse();
    return folders;
  }, [listing, prefix, search, sortKey, sortDir]);

  const displayedObjects = useMemo(() => {
    const q = search.trim().toLowerCase();
    let objects = (listing?.objects ?? []).filter(
      (o) => !q || basename(o.key).toLowerCase().includes(q),
    );
    if (activeCategories.size > 0) {
      objects = objects.filter((o) => activeCategories.has(fileCategory(o.key)));
    }
    const dir = sortDir === "asc" ? 1 : -1;
    objects = [...objects].sort((a, b) => {
      if (sortKey === "size") return (a.size - b.size) * dir;
      if (sortKey === "modified") {
        return (Date.parse(a.last_modified) - Date.parse(b.last_modified)) * dir;
      }
      return basename(a.key).localeCompare(basename(b.key)) * dir;
    });
    return objects;
  }, [listing, search, activeCategories, sortKey, sortDir]);

  const segments = prefix.split("/").filter(Boolean);
  const emptyAfterFilter =
    !error && !loading && listing && displayedFolders.length === 0 && displayedObjects.length === 0;

  return (
    <div className="flex min-h-0 flex-1">
      <ResizablePanelGroup
        orientation="horizontal"
        defaultLayout={savedLayout}
        onLayoutChanged={(layout) => setLayout("object-browser", layout)}
      >
        <ResizablePanel id="objects" defaultSize={60} minSize={30}>
          <div className="flex h-full min-w-0 flex-col">
            {/* Breadcrumb */}
            <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-3 text-xs">
              <button
                type="button"
                onClick={() => navigateTo("")}
                className="font-medium text-foreground hover:underline"
              >
                {bucket}
              </button>
              {segments.map((seg, i) => {
                const upto = `${segments.slice(0, i + 1).join("/")}/`;
                return (
                  <span key={upto} className="flex items-center gap-1 text-muted-foreground">
                    <ChevronRight className="size-3" />
                    <button
                      type="button"
                      onClick={() => navigateTo(upto)}
                      className="hover:text-foreground hover:underline"
                    >
                      {seg}
                    </button>
                  </span>
                );
              })}
              <Button
                size="icon"
                variant="ghost"
                className="ml-auto size-6"
                onClick={refresh}
                title="Refresh"
                aria-label="Refresh"
              >
                <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
              </Button>
            </div>

            {/* Toolbar: search + filter + write actions */}
            <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-border px-2">
              <div className="relative flex-1">
                <Search className="-translate-y-1/2 absolute top-1/2 left-2 size-3.5 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search by name…"
                  className="h-7 pl-7 text-xs"
                />
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="sm"
                    variant={activeCategories.size > 0 ? "secondary" : "ghost"}
                    className="h-7 gap-1 px-2 text-xs"
                  >
                    <Filter className="size-3.5" />
                    Type
                    {activeCategories.size > 0 && ` (${activeCategories.size})`}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuLabel>File type</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {presentCategories.length === 0 ? (
                    <div className="px-2 py-1.5 text-xs text-muted-foreground">No files</div>
                  ) : (
                    presentCategories.map((cat) => (
                      <DropdownMenuCheckboxItem
                        key={cat}
                        checked={activeCategories.has(cat)}
                        onCheckedChange={() => toggleCategory(cat)}
                        onSelect={(e) => e.preventDefault()}
                      >
                        {CATEGORY_LABEL[cat]}
                      </DropdownMenuCheckboxItem>
                    ))
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 gap-1 px-2 text-xs"
                onClick={() => setTextDialog({ kind: "newFolder", value: "" })}
                title="New folder"
              >
                <FolderPlus className="size-3.5" />
                Folder
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 gap-1 px-2 text-xs"
                    title="Upload"
                  >
                    <Upload className="size-3.5" />
                    Upload
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => void handleUpload()}>
                    <Upload className="size-3.5" />
                    Upload file…
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => void handleUploadDir()}>
                    <FolderUp className="size-3.5" />
                    Upload folder…
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            <div className="min-h-0 flex-1 overflow-auto">
              {error ? (
                <div className="p-4 text-sm text-destructive">{error}</div>
              ) : (
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-background">
                    <tr className="border-b border-border text-muted-foreground">
                      <SortHeader
                        label="Name"
                        active={sortKey === "name"}
                        dir={sortDir}
                        onClick={() => toggleSort("name")}
                        className="text-left"
                      />
                      <SortHeader
                        label="Size"
                        active={sortKey === "size"}
                        dir={sortDir}
                        onClick={() => toggleSort("size")}
                        className="text-right"
                      />
                      <SortHeader
                        label="Modified"
                        active={sortKey === "modified"}
                        dir={sortDir}
                        onClick={() => toggleSort("modified")}
                        className="text-right"
                      />
                      <th className="w-16" />
                    </tr>
                  </thead>
                  <tbody>
                    {displayedFolders.map((f) => (
                      <tr
                        key={f}
                        onClick={() => navigateTo(f)}
                        className="group cursor-pointer border-b border-border/50 hover:bg-sidebar-accent"
                      >
                        <td className="px-3 py-1.5 align-middle">
                          <div className="flex items-center gap-2">
                            <Folder className="size-3.5 shrink-0 text-primary" />
                            <span className="truncate">{folderName(f, prefix)}/</span>
                          </div>
                        </td>
                        <td className="px-3 py-1.5 text-right align-middle text-muted-foreground">
                          —
                        </td>
                        <td className="px-3 py-1.5 text-right align-middle text-muted-foreground">
                          —
                        </td>
                        <td className="px-1 py-1.5 text-right align-middle">
                          <div className="flex items-center justify-end opacity-0 group-hover:opacity-100">
                            <Button
                              size="icon"
                              variant="ghost"
                              className="size-6"
                              onClick={(e) => {
                                e.stopPropagation();
                                setTextDialog({
                                  kind: "renameFolder",
                                  value: folderName(f, prefix),
                                  original: f,
                                });
                              }}
                              title="Rename folder"
                              aria-label="Rename folder"
                            >
                              <Pencil className="size-3.5" />
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="size-6"
                              onClick={(e) => {
                                e.stopPropagation();
                                setConfirm({
                                  title: "Delete folder?",
                                  description: `This permanently deletes every object under “${folderName(f, prefix)}/”.`,
                                  action: () => deleteFolder(f),
                                });
                              }}
                              title="Delete folder"
                              aria-label="Delete folder"
                            >
                              <Trash2 className="size-3.5" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                    {displayedObjects.map((o) => (
                      <ObjectRow
                        key={o.key}
                        object={o}
                        selected={selectedKey === o.key}
                        downloading={downloadingKey === o.key}
                        onSelect={() => void selectObject(o.key)}
                        onDownload={() => void download(o.key)}
                        onRename={() =>
                          setTextDialog({
                            kind: "rename",
                            value: basename(o.key),
                            original: o.key,
                          })
                        }
                        onDelete={() =>
                          setConfirm({
                            title: "Delete object?",
                            description: `This permanently deletes “${basename(o.key)}”.`,
                            action: () => deleteObject(o.key),
                          })
                        }
                      />
                    ))}
                  </tbody>
                </table>
              )}

              {emptyAfterFilter && (
                <div className="p-4 text-sm text-muted-foreground">
                  {search || activeCategories.size > 0
                    ? "No objects match the current filters."
                    : "This folder is empty."}
                </div>
              )}
              {listing?.next_token && (
                <div className="p-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full"
                    disabled={loading}
                    onClick={() => void load(listing.next_token)}
                  >
                    Load more
                  </Button>
                </div>
              )}
            </div>
          </div>
        </ResizablePanel>

        <ResizableHandle withHandle />

        <ResizablePanel id="preview" defaultSize={40} minSize={20}>
          <div className="flex h-full min-w-0 flex-col">
            {!selectedKey ? (
              <div className="flex flex-1 items-center justify-center p-4 text-sm text-muted-foreground">
                Select an object to preview.
              </div>
            ) : (
              <>
                <div className="shrink-0 border-b border-border px-3 py-2">
                  <div className="truncate text-sm font-medium" title={selectedKey}>
                    {basename(selectedKey)}
                  </div>
                  {preview && (
                    <div className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-muted-foreground">
                      <span>{formatBytes(preview.meta.content_length ?? preview.body.size)}</span>
                      {preview.meta.content_type && <span>{preview.meta.content_type}</span>}
                      <span>{formatDate(preview.meta.last_modified)}</span>
                    </div>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-2"
                    disabled={downloadingKey === selectedKey}
                    onClick={() => void download(selectedKey)}
                  >
                    <Download className="size-3.5" /> Download
                  </Button>
                </div>
                <div className="min-h-0 flex-1 overflow-auto">
                  {previewLoading ? (
                    <div className="p-3 text-sm text-muted-foreground">Loading preview…</div>
                  ) : preview ? (
                    <ObjectPreview
                      key={selectedKey}
                      conn={conn}
                      bucket={bucket}
                      objectKey={selectedKey}
                      meta={preview.meta}
                      body={preview.body}
                    />
                  ) : null}
                </div>
              </>
            )}
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>

      {/* Destructive-action confirmation */}
      <AlertDialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm?.title}</AlertDialogTitle>
            <AlertDialogDescription>{confirm?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                confirm?.action();
                setConfirm(null);
              }}
            >
              Confirm
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Rename / new-folder text dialog */}
      <Dialog open={textDialog !== null} onOpenChange={(open) => !open && setTextDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {textDialog?.kind === "rename"
                ? "Rename object"
                : textDialog?.kind === "renameFolder"
                  ? "Rename folder"
                  : "New folder"}
            </DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            value={textDialog?.value ?? ""}
            onChange={(e) =>
              setTextDialog((prev) => (prev ? { ...prev, value: e.target.value } : prev))
            }
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                document.getElementById("s3-text-dialog-submit")?.click();
              }
            }}
            placeholder={textDialog?.kind === "newFolder" ? "Folder name" : "New name"}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setTextDialog(null)}>
              Cancel
            </Button>
            <Button
              id="s3-text-dialog-submit"
              onClick={() => {
                if (!textDialog) return;
                if (textDialog.kind === "rename" && textDialog.original) {
                  renameObject(textDialog.original, textDialog.value);
                } else if (textDialog.kind === "renameFolder" && textDialog.original) {
                  renameFolder(textDialog.original, textDialog.value);
                } else if (textDialog.kind === "newFolder") {
                  createFolder(textDialog.value);
                }
                setTextDialog(null);
              }}
            >
              {textDialog?.kind === "newFolder" ? "Create" : "Rename"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SortHeader({
  label,
  active,
  dir,
  onClick,
  className,
}: {
  label: string;
  active: boolean;
  dir: SortDir;
  onClick: () => void;
  className?: string;
}) {
  return (
    <th className={cn("px-3 py-1.5 font-medium", className)}>
      <button
        type="button"
        onClick={onClick}
        className={cn(
          "inline-flex items-center gap-1 hover:text-foreground",
          active && "text-foreground",
        )}
      >
        {label}
        {active &&
          (dir === "asc" ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
      </button>
    </th>
  );
}

function ObjectRow({
  object,
  selected,
  downloading,
  onSelect,
  onDownload,
  onRename,
  onDelete,
}: {
  object: S3Object;
  selected: boolean;
  downloading: boolean;
  onSelect: () => void;
  onDownload: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const Icon = fileIcon(object.key);
  return (
    <tr
      onClick={onSelect}
      className={cn(
        "group cursor-pointer border-b border-border/50 hover:bg-sidebar-accent",
        selected && "bg-primary/10",
      )}
    >
      <td className="px-3 py-1.5 align-middle">
        <div className="flex items-center gap-2">
          <Icon className={cn("size-3.5 shrink-0", fileIconColor(object.key))} />
          <span className="truncate">{basename(object.key)}</span>
        </div>
      </td>
      <td className="whitespace-nowrap px-3 py-1.5 text-right align-middle text-muted-foreground">
        {formatBytes(object.size)}
      </td>
      <td className="whitespace-nowrap px-3 py-1.5 text-right align-middle text-muted-foreground">
        {formatDate(object.last_modified)}
      </td>
      <td className="px-1 py-1.5 text-right align-middle">
        <div className="flex items-center justify-end opacity-0 group-hover:opacity-100">
          <Button
            size="icon"
            variant="ghost"
            className="size-6"
            disabled={downloading}
            onClick={(e) => {
              e.stopPropagation();
              onDownload();
            }}
            title="Download"
            aria-label="Download"
          >
            <Download className="size-3.5" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="size-6"
            onClick={(e) => {
              e.stopPropagation();
              onRename();
            }}
            title="Rename"
            aria-label="Rename"
          >
            <Pencil className="size-3.5" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="size-6"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            title="Delete"
            aria-label="Delete"
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      </td>
    </tr>
  );
}

/** Naive CSV split for preview only (no embedded-newline / quote handling). */
function parseCsv(text: string, maxRows = 200): string[][] {
  return text
    .split(/\r?\n/)
    .filter((l) => l.length > 0)
    .slice(0, maxRows)
    .map((line) => line.split(","));
}

function ObjectPreview({
  conn,
  bucket,
  objectKey,
  meta,
  body,
}: {
  conn: SavedConnection;
  bucket: string;
  objectKey: string;
  meta: S3ObjectMeta;
  body: S3ObjectPreview;
}) {
  const category = fileCategory(objectKey, meta.content_type);
  const ext = fileExtension(objectKey);
  const isImage = category === "image";
  // Whole-file render via the asset protocol: PDFs, media, large images.
  const needsCache =
    category === "pdf" ||
    category === "audio" ||
    category === "video" ||
    (isImage && (body.kind !== "image" || body.truncated));
  const isArchive = category === "archive";

  const [cacheUrl, setCacheUrl] = useState<string | null>(null);
  const [archive, setArchive] = useState<S3ArchiveEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (needsCache) {
      ipc
        .s3CacheObject(conn.id, bucket, objectKey)
        .then((c) => !cancelled && setCacheUrl(convertFileSrc(c.path)))
        .catch((e) => !cancelled && setLoadError(String(e)));
    } else if (isArchive) {
      ipc
        .s3ArchiveEntries(conn.id, bucket, objectKey)
        .then((entries) => !cancelled && setArchive(entries))
        .catch((e) => !cancelled && setLoadError(String(e)));
    }
    return () => {
      cancelled = true;
    };
  }, [needsCache, isArchive, conn.id, bucket, objectKey]);

  if (loadError) {
    return <div className="p-3 text-sm text-destructive">{loadError}</div>;
  }

  // Inline image small enough to have come back as base64.
  if (isImage && body.kind === "image" && body.base64 && !body.truncated) {
    return (
      <img
        src={`data:${meta.content_type ?? "image/*"};base64,${body.base64}`}
        alt="object preview"
        className="max-h-full max-w-full object-contain p-3"
      />
    );
  }

  if (needsCache) {
    if (!cacheUrl) {
      return <div className="p-3 text-sm text-muted-foreground">Loading preview…</div>;
    }
    if (isImage) {
      return (
        <img
          src={cacheUrl}
          alt="object preview"
          className="max-h-full max-w-full object-contain p-3"
        />
      );
    }
    if (category === "pdf") {
      return <iframe src={cacheUrl} title="PDF preview" className="h-full w-full border-0" />;
    }
    if (category === "audio") {
      return (
        <div className="p-3">
          {/* biome-ignore lint/a11y/useMediaCaption: user object, no captions available */}
          <audio src={cacheUrl} controls className="w-full" />
        </div>
      );
    }
    if (category === "video") {
      return (
        // biome-ignore lint/a11y/useMediaCaption: user object, no captions available
        <video src={cacheUrl} controls className="max-h-full max-w-full p-3" />
      );
    }
  }

  if (isArchive) {
    if (!archive) {
      return <div className="p-3 text-sm text-muted-foreground">Reading archive…</div>;
    }
    return (
      <table className="w-full text-xs">
        <tbody>
          {archive.map((e) => (
            <tr key={e.name} className="border-b border-border/50">
              <td className="truncate px-3 py-1 font-mono">{e.name}</td>
              <td className="whitespace-nowrap px-3 py-1 text-right text-muted-foreground">
                {e.is_dir ? "—" : formatBytes(e.size)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  // CSV → table.
  if (category === "spreadsheet" && (ext === "csv" || ext === "tsv") && body.text != null) {
    const rows = parseCsv(body.text);
    return (
      <div className="overflow-auto p-3">
        <table className="text-xs">
          <tbody>
            {rows.map((cells, ri) => (
              <tr key={ri} className="border-b border-border/50">
                {cells.map((c, ci) => (
                  <td key={ci} className="border-border/50 border-r px-2 py-0.5 last:border-r-0">
                    {c}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {body.truncated && (
          <div className="mt-2 text-[11px] text-muted-foreground">
            Preview truncated — download the object to see the rest.
          </div>
        )}
      </div>
    );
  }

  // Markdown → rendered.
  if ((ext === "md" || ext === "markdown") && body.text != null) {
    return (
      <div className="prose prose-sm dark:prose-invert max-w-none p-3">
        <ReactMarkdown>{body.text}</ReactMarkdown>
        {body.truncated && (
          <div className="mt-2 text-[11px] text-muted-foreground">
            Preview truncated — download the object to see the rest.
          </div>
        )}
      </div>
    );
  }

  // Plain text / code.
  if (body.kind === "text" && body.text != null) {
    return (
      <div className="p-3">
        <pre className="whitespace-pre-wrap break-words font-mono text-xs">{body.text}</pre>
        {body.truncated && (
          <div className="mt-2 text-[11px] text-muted-foreground">
            Preview truncated — download the object to see the rest.
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="p-3 text-sm text-muted-foreground">
      No inline preview for this type. Use Download to save it.
    </div>
  );
}
