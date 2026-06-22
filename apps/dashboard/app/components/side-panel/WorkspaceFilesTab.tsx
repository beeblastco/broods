"use client";

/** VSCode-style file explorer for a workspace canvas node with drag-and-drop upload. */
import { DeleteConfirmDialog } from "@/app/components/DeleteConfirmDialog";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { cn } from "@/app/lib/utils";
import { api } from "@broods/convex/_generated/api";
import type { Id } from "@broods/convex/_generated/dataModel";
import { useAction, useMutation, useQuery } from "convex/react";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  FolderUp,
  Loader2,
  Pencil,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react";
import { FileIcon, defaultStyles } from "react-file-icon";
import type { StyleProps } from "react-file-icon";
import { useCallback, useEffect, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type FileRecord = {
  _id?: Id<"workspaceFiles">;
  path: string;
  name: string;
  isFolder: boolean;
  storageId?: Id<"_storage">;
  mimeType?: string;
  sizeBytes?: number;
  updatedAt?: string | number;
};

type FileNode = FileRecord & {
  children?: FileNode[];
};

type RuntimeFileCacheEntry = {
  files: FileRecord[];
  cachedAt: number;
};

const RUNTIME_FILE_CACHE_PREFIX = "broods.workspace-files.v1";
const runtimeFileCache = new Map<string, RuntimeFileCacheEntry>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildTree(files: FileRecord[]): FileNode[] {
  const map = new Map<string, FileNode>();
  for (const f of files) {
    map.set(f.path, { ...f, children: f.isFolder ? [] : undefined });
  }

  const roots: FileNode[] = [];
  for (const [path, node] of map) {
    const slash = path.lastIndexOf("/");
    if (slash === -1) {
      roots.push(node);
    } else {
      const parentPath = path.slice(0, slash);
      const parent = map.get(parentPath);
      if (parent?.children) {
        parent.children.push(node);
      } else {
        roots.push(node);
      }
    }
  }

  const sort = (nodes: FileNode[]) => {
    nodes.sort((a, b) => {
      if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const n of nodes) {
      if (n.children) sort(n.children);
    }
  };
  sort(roots);

  return roots;
}

function withoutPath(files: FileRecord[], path: string): FileRecord[] {
  return files.filter((file) => file.path !== path && !file.path.startsWith(`${path}/`));
}

function withRenamedPath(files: FileRecord[], path: string, newPath: string): FileRecord[] {
  return files.map((file) => {
    if (file.path !== path && !file.path.startsWith(`${path}/`)) return file;
    const nextPath = `${newPath}${file.path.slice(path.length)}`;

    return {
      ...file,
      path: nextPath,
      ...(file.path === path ? { name: newPath.split("/").at(-1)! } : {}),
    };
  });
}

function runtimeFileCacheKey(projectId: string | undefined, workspaceId: string | undefined): string | undefined {
  return projectId && workspaceId ? `${projectId}:${workspaceId}` : undefined;
}

function readRuntimeFileCache(key: string | undefined): RuntimeFileCacheEntry | undefined {
  if (!key) return undefined;
  const memory = runtimeFileCache.get(key);
  if (memory) return memory;
  if (typeof window === "undefined") return undefined;
  try {
    const raw = window.sessionStorage.getItem(`${RUNTIME_FILE_CACHE_PREFIX}:${key}`);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as RuntimeFileCacheEntry;
    if (!Array.isArray(parsed.files) || typeof parsed.cachedAt !== "number") return undefined;
    runtimeFileCache.set(key, parsed);
    return parsed;
  } catch {
    return undefined;
  }
}

function writeRuntimeFileCache(key: string | undefined, files: FileRecord[]): void {
  if (!key) return;
  const entry = { files: files, cachedAt: Date.now() };
  runtimeFileCache.set(key, entry);
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(`${RUNTIME_FILE_CACHE_PREFIX}:${key}`, JSON.stringify(entry));
  } catch {
    // Cache failures must never block workspace access.
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function readAllEntries(
  reader: FileSystemDirectoryReader,
): Promise<FileSystemEntry[]> {
  const all: FileSystemEntry[] = [];
  while (true) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => {
      reader.readEntries(resolve, reject);
    });
    if (batch.length === 0) break;
    all.push(...batch);
  }
  return all;
}

async function collectEntries(
  entry: FileSystemEntry,
  parentPath: string,
  files: Array<{ file: File; path: string }>,
  folders: string[],
): Promise<void> {
  const currentPath = parentPath ? `${parentPath}/${entry.name}` : entry.name;
  if (entry.isFile) {
    const fileEntry = entry as FileSystemFileEntry;
    const file = await new Promise<File>((resolve, reject) =>
      fileEntry.file(resolve, reject),
    );
    files.push({ file: file, path: currentPath });
  } else if (entry.isDirectory) {
    folders.push(currentPath);
    const dirEntry = entry as FileSystemDirectoryEntry;
    const children = await readAllEntries(dirEntry.createReader());
    for (const child of children) {
      await collectEntries(child, currentPath, files, folders);
    }
  }
}

async function fileToBase64(file: File): Promise<string> {
  if (file.size > 512 * 1024) {
    throw new Error(`${file.name} exceeds the 512 KiB dashboard upload limit.`);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunkSize = 32 * 1024;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

/** Renders a colored file type icon via react-file-icon. */
function ExtIcon({ name }: { name: string }) {
  const ext = name.includes(".")
    ? (name.split(".").pop()?.toLowerCase() ?? "")
    : "";
  const style: StyleProps =
    (defaultStyles as Record<string, StyleProps>)[ext] ?? {};

  return (
    <span className="mr-1.5 inline-flex size-[14px] shrink-0 items-center">
      <FileIcon extension={ext} {...style} />
    </span>
  );
}

// ---------------------------------------------------------------------------
// Inline rename input
// ---------------------------------------------------------------------------

function RenameInput({
  initialValue,
  onCommit,
  onCancel,
}: {
  initialValue: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initialValue);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.select();
  }, []);

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== initialValue) {
      onCommit(trimmed);
    } else {
      onCancel();
    }
  };

  return (
    <Input
      ref={ref}
      value={draft}
      className="h-[18px] flex-1 rounded-sm border-primary px-1 py-0 font-mono text-[12px]"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        }
        if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
      onClick={(e) => e.stopPropagation()}
    />
  );
}

// ---------------------------------------------------------------------------
// Tree row
// ---------------------------------------------------------------------------

function TreeRow({
  node,
  depth,
  expanded,
  uploading,
  selected,
  renamingPath,
  onSelect,
  onToggle,
  onDelete,
  onRenameStart,
  onRenameCommit,
  onRenameCancel,
}: {
  node: FileNode;
  depth: number;
  expanded: Set<string>;
  uploading: Set<string>;
  selected: string | null;
  renamingPath: string | null;
  onSelect: (path: string) => void;
  onToggle: (path: string) => void;
  onDelete: (node: FileNode) => void;
  onRenameStart: (path: string) => void;
  onRenameCommit: (node: FileNode, newName: string) => void;
  onRenameCancel: () => void;
}) {
  const isExpanded = expanded.has(node.path);
  const isSelected = selected === node.path;
  const isRenaming = renamingPath === node.path;
  const isUploading = uploading.has(node.path);

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onSelect(node.path);
    if (node.isFolder) onToggle(node.path);
  };

  return (
    <>
      <div
        className={cn(
          "group flex h-[22px] select-none items-center gap-0 pr-1 text-[13px]",
          "cursor-pointer",
          isSelected
            ? "bg-accent text-accent-foreground"
            : "text-foreground/80 hover:bg-muted/50",
        )}
        style={{ paddingLeft: `${4 + depth * 16}px` }}
        onClick={handleClick}
        title={isRenaming ? undefined : node.path}
      >
        {/* chevron / spacer */}
        <span className="flex w-4 shrink-0 items-center justify-center">
          {node.isFolder ? (
            isExpanded ? (
              <ChevronDown className="size-3 text-muted-foreground" />
            ) : (
              <ChevronRight className="size-3 text-muted-foreground" />
            )
          ) : null}
        </span>

        {/* icon */}
        {node.isFolder ? (
          isExpanded ? (
            <FolderOpen className="mr-1.5 size-[14px] shrink-0 text-yellow-400" />
          ) : (
            <Folder className="mr-1.5 size-[14px] shrink-0 text-yellow-400" />
          )
        ) : (
          <ExtIcon name={node.name} />
        )}

        {/* name or rename input */}
        {isRenaming ? (
          <RenameInput
            initialValue={node.name}
            onCommit={(newName) => onRenameCommit(node, newName)}
            onCancel={onRenameCancel}
          />
        ) : (
          <span
            className="flex-1 truncate font-mono text-[12px]"
            onDoubleClick={(e) => {
              e.stopPropagation();
              onRenameStart(node.path);
            }}
          >
            {node.name}
          </span>
        )}

        {/* size hint when selected */}
        {!node.isFolder &&
          node.sizeBytes !== undefined &&
          isSelected &&
          !isRenaming && (
            <span className="mr-1 shrink-0 text-[10px] text-muted-foreground/60">
              {formatBytes(node.sizeBytes)}
            </span>
          )}

        {/* action buttons — visible on hover or when selected */}
        {!isRenaming && (
          <span
            className={cn(
              "flex shrink-0 items-center gap-0.5",
              isSelected ? "opacity-100" : "opacity-0 group-hover:opacity-100",
            )}
          >
            {isUploading ? (
              <Loader2 className="size-3.5 animate-spin text-muted-foreground/60" />
            ) : (
              <>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  className="size-5 cursor-pointer"
                  title="Rename"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRenameStart(node.path);
                  }}
                >
                  <Pencil className="size-3.5" />
                </Button>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  className="size-5 cursor-pointer text-destructive hover:text-destructive"
                  title="Delete"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(node);
                  }}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </>
            )}
          </span>
        )}
      </div>

      {/* children */}
      {node.isFolder &&
        isExpanded &&
        node.children?.map((child) => (
          <TreeRow
            key={child.path}
            node={child}
            depth={depth + 1}
            expanded={expanded}
            uploading={uploading}
            selected={selected}
            renamingPath={renamingPath}
            onSelect={onSelect}
            onToggle={onToggle}
            onDelete={onDelete}
            onRenameStart={onRenameStart}
            onRenameCommit={onRenameCommit}
            onRenameCancel={onRenameCancel}
          />
        ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

/** VSCode-style file explorer panel for a workspace canvas node. */
export function WorkspaceFilesTab({
  projectId,
  nodeId,
  workspaceId,
}: {
  projectId: Id<"projects"> | undefined;
  nodeId: string;
  workspaceId?: string;
}) {
  const convexFiles = useQuery(
    api.workspaceFiles.list,
    projectId && !workspaceId ? { projectId: projectId, nodeId: nodeId } : "skip",
  );

  const generateUploadUrl = useMutation(api.workspaceFiles.generateUploadUrl);
  const createFile = useMutation(api.workspaceFiles.create);
  const removeFile = useMutation(api.workspaceFiles.remove);
  const removeFolderMut = useMutation(api.workspaceFiles.removeFolder);
  const renameMut = useMutation(api.workspaceFiles.rename);
  const listRuntimeFiles = useAction(api.workspaceFilesPublic.list);
  const migrateLegacyFiles = useAction(api.workspaceFilesPublic.migrateLegacy);
  const uploadRuntimeFile = useAction(api.workspaceFilesPublic.upload);
  const removeRuntimePath = useAction(api.workspaceFilesPublic.remove);
  const renameRuntimePath = useAction(api.workspaceFilesPublic.rename);

  const cacheKey = runtimeFileCacheKey(projectId, workspaceId);
  const [runtimeFiles, setRuntimeFiles] = useState<FileRecord[] | undefined>(
    () => runtimeFileCache.get(cacheKey ?? "")?.files,
  );
  const [syncedWorkspaceId, setSyncedWorkspaceId] = useState(workspaceId);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [uploading, setUploading] = useState<Set<string>>(new Set());
  const [isDragOver, setIsDragOver] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Node pending delete confirmation.
  const [pendingDeleteNode, setPendingDeleteNode] = useState<FileNode | null>(null);
  const [isDeletingNode, setIsDeletingNode] = useState(false);
  const refreshRequestRef = useRef(0);
  const refreshPromiseRef = useRef<Promise<FileRecord[]> | undefined>(undefined);
  const dragCounter = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  if (workspaceId !== syncedWorkspaceId) {
    setSyncedWorkspaceId(workspaceId);
    setRuntimeFiles(readRuntimeFileCache(cacheKey)?.files);
  }

  const applyRuntimeFiles = useCallback((next: FileRecord[]) => {
    writeRuntimeFileCache(cacheKey, next);
    setRuntimeFiles(next);
  }, [cacheKey]);

  const refreshRuntimeFiles = useCallback(async (showIndicator = false, force = false) => {
    if (!projectId || !workspaceId) return;
    if (refreshPromiseRef.current && !force) return refreshPromiseRef.current;
    const request = ++refreshRequestRef.current;
    if (showIndicator) setIsRefreshing(true);
    const pending = listRuntimeFiles({ projectId: projectId, workspaceId: workspaceId });
    refreshPromiseRef.current = pending;
    try {
      const next = await pending;
      if (request === refreshRequestRef.current) applyRuntimeFiles(next);
      return next;
    } finally {
      if (refreshPromiseRef.current === pending) refreshPromiseRef.current = undefined;
      if (showIndicator) setIsRefreshing(false);
    }
  }, [applyRuntimeFiles, listRuntimeFiles, projectId, workspaceId]);

  useEffect(() => {
    if (!projectId || !workspaceId) return;
    let cancelled = false;
    const cached = readRuntimeFileCache(cacheKey);
    if (cached) {
      void Promise.resolve().then(() => {
        if (!cancelled) setRuntimeFiles(cached.files);
      });
    }
    const request = ++refreshRequestRef.current;
    const pending = migrateLegacyFiles({ projectId: projectId, nodeId: nodeId, workspaceId: workspaceId });
    refreshPromiseRef.current = pending;
    void pending
      .then((next) => {
        if (!cancelled && request === refreshRequestRef.current) applyRuntimeFiles(next);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load workspace files.");
        if (!cached) setRuntimeFiles([]);
      })
      .finally(() => {
        if (refreshPromiseRef.current === pending) refreshPromiseRef.current = undefined;
      });
    return () => {
      cancelled = true;
    };
  }, [applyRuntimeFiles, cacheKey, migrateLegacyFiles, nodeId, projectId, workspaceId]);

  useEffect(() => {
    if (!workspaceId) return;
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") {
        void refreshRuntimeFiles().catch(() => {});
      }
    };
    const interval = window.setInterval(refreshWhenVisible, 5000);
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);

    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [refreshRuntimeFiles, workspaceId]);

  const files = workspaceId ? runtimeFiles : convexFiles;

  // Deselect when clicking the blank area of the panel
  const handleContainerClick = useCallback(() => {
    setSelected(null);
    setRenamingPath(null);
  }, []);

  const executeDelete = useCallback(
    async (node: FileNode) => {
      if (!projectId) return;
      setSelected(null);
      if (workspaceId) {
        refreshRequestRef.current += 1;
        const optimistic = runtimeFiles ? withoutPath(runtimeFiles, node.path) : undefined;
        if (optimistic) applyRuntimeFiles(optimistic);
        try {
          await removeRuntimePath({ projectId: projectId, workspaceId: workspaceId, path: node.path });
          await refreshRuntimeFiles(false, true);
        } catch (err) {
          setError(err instanceof Error ? err.message : "Failed to delete workspace path.");
          await refreshRuntimeFiles(false, true);
        }
        return;
      }
      if (node.isFolder) {
        await removeFolderMut({
          projectId: projectId,
          nodeId: nodeId,
          folderPath: node.path,
        });
      } else {
        await removeFile({ fileId: node._id! });
      }
    },
    [applyRuntimeFiles, projectId, workspaceId, nodeId, removeFile, removeFolderMut, removeRuntimePath, refreshRuntimeFiles, runtimeFiles],
  );

  // Opens the delete confirmation dialog for a node (click or keyboard Delete).
  const handleDelete = useCallback((node: FileNode) => {
    setPendingDeleteNode(node);
  }, []);

  // Keyboard: Delete/Backspace = open delete dialog for selected, F2 = rename selected
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (renamingPath) return;
      if (
        (e.key === "Delete" || e.key === "Backspace") &&
        selected &&
        document.activeElement?.tagName !== "INPUT"
      ) {
        const match = files?.find((f: FileRecord) => f.path === selected);
        if (match) setPendingDeleteNode(match as FileNode);
      }
      if (e.key === "F2" && selected) {
        setRenamingPath(selected);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selected, renamingPath, files]);

  const toggleFolder = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const uploadFiles = useCallback(
    async (entries: Array<{ file: File; path: string }>, folders: string[]) => {
      if (!projectId) return;
      setError(null);

      setUploading((prev) => {
        const next = new Set(prev);
        for (const { path } of entries) next.add(path);
        return next;
      });

      if (folders.length > 0) {
        setExpanded((prev) => {
          const next = new Set(prev);
          for (const fp of folders) next.add(fp);
          return next;
        });
      }

      try {
        if (!workspaceId) {
          for (const folderPath of folders) {
            const parts = folderPath.split("/");
            await createFile({
              projectId: projectId,
              nodeId: nodeId,
              path: folderPath,
              name: parts[parts.length - 1],
              isFolder: true,
            });
          }
        }

        for (const { file, path } of entries) {
          try {
            if (workspaceId) {
              await uploadRuntimeFile({
                projectId: projectId,
                workspaceId: workspaceId,
                path: path,
                contentBase64: await fileToBase64(file),
                contentType: file.type || undefined,
              });
              continue;
            }
            const uploadUrl = await generateUploadUrl();
            const res = await fetch(uploadUrl, {
              method: "POST",
              headers: {
                "Content-Type": file.type || "application/octet-stream",
              },
              body: file,
            });
            if (!res.ok) throw new Error(`Upload failed: ${res.statusText}`);
            const { storageId } = (await res.json()) as {
              storageId: Id<"_storage">;
            };
            const parts = path.split("/");
            await createFile({
              projectId: projectId,
              nodeId: nodeId,
              path: path,
              name: parts[parts.length - 1],
              isFolder: false,
              storageId: storageId,
              mimeType: file.type || undefined,
              sizeBytes: file.size,
            });
          } finally {
            setUploading((prev) => {
              const next = new Set(prev);
              next.delete(path);
              return next;
            });
          }
        }
        if (workspaceId) await refreshRuntimeFiles(false, true);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Upload failed.");
      }
    },
    [projectId, workspaceId, nodeId, generateUploadUrl, createFile, uploadRuntimeFile, refreshRuntimeFiles],
  );

  const handleDrop = useCallback(
    async (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      dragCounter.current = 0;
      setIsDragOver(false);

      const fileEntries: Array<{ file: File; path: string }> = [];
      const folderPaths: string[] = [];

      for (const item of Array.from(e.dataTransfer.items)) {
        if (item.kind !== "file") continue;
        const entry = item.webkitGetAsEntry?.();
        if (entry) {
          await collectEntries(entry, "", fileEntries, folderPaths);
        } else {
          const f = item.getAsFile();
          if (f) fileEntries.push({ file: f, path: f.name });
        }
      }

      await uploadFiles(fileEntries, folderPaths);
    },
    [uploadFiles],
  );

  const handleDragEnter = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragCounter.current += 1;
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragCounter.current -= 1;
    if (dragCounter.current === 0) setIsDragOver(false);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
  }, []);

  const handleFileInputChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const selected = Array.from(e.target.files ?? []);
      if (!selected.length) return;

      const entries = selected.map((f) => ({
        file: f,
        path:
          (f as File & { webkitRelativePath?: string }).webkitRelativePath ||
          f.name,
      }));

      const folderSet = new Set<string>();
      for (const { path } of entries) {
        const parts = path.split("/");
        for (let i = 1; i < parts.length; i++) {
          folderSet.add(parts.slice(0, i).join("/"));
        }
      }

      await uploadFiles(entries, Array.from(folderSet));
      e.target.value = "";
    },
    [uploadFiles],
  );

  const handleRenameCommit = useCallback(
    async (node: FileNode, newName: string) => {
      setRenamingPath(null);
      if (workspaceId && projectId) {
        const slash = node.path.lastIndexOf("/");
        const newPath = slash === -1 ? newName : `${node.path.slice(0, slash)}/${newName}`;
        refreshRequestRef.current += 1;
        const optimistic = runtimeFiles ? withRenamedPath(runtimeFiles, node.path, newPath) : undefined;
        if (optimistic) applyRuntimeFiles(optimistic);
        try {
          await renameRuntimePath({
            projectId: projectId,
            workspaceId: workspaceId,
            path: node.path,
            newPath: newPath,
          });
          await refreshRuntimeFiles(false, true);
        } catch (err) {
          setError(err instanceof Error ? err.message : "Failed to rename workspace path.");
          await refreshRuntimeFiles(false, true);
        }
        return;
      }
      await renameMut({ fileId: node._id!, newName: newName });
    },
    [applyRuntimeFiles, workspaceId, projectId, renameRuntimePath, refreshRuntimeFiles, renameMut, runtimeFiles],
  );

  const tree = files ? buildTree(files as FileRecord[]) : [];

  return (
    <div
      ref={containerRef}
      className={cn(
        "relative flex flex-1 flex-col overflow-hidden",
        isDragOver && "ring-2 ring-inset ring-primary/50",
      )}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onClick={handleContainerClick}
    >
      {/* Toolbar */}
      <div className="flex shrink-0 items-center justify-end gap-0.5 px-3 py-2">
        {workspaceId && (
          <Button
            size="icon-xs"
            variant="ghost"
            className="cursor-pointer disabled:cursor-not-allowed"
            title="Refresh workspace files"
            disabled={isRefreshing}
            onClick={(e) => {
              e.stopPropagation();
              void refreshRuntimeFiles(true, true).catch((err) => {
                setError(err instanceof Error ? err.message : "Failed to refresh workspace files.");
              });
            }}
          >
            <RefreshCw className={cn("size-3.5", isRefreshing && "animate-spin")} />
          </Button>
        )}
        <Button
          size="icon-xs"
          variant="ghost"
          className="cursor-pointer"
          title="Upload files"
          onClick={(e) => {
            e.stopPropagation();
            fileInputRef.current?.click();
          }}
        >
          <Upload className="size-3.5" />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          className="cursor-pointer"
          title="Upload folder"
          onClick={(e) => {
            e.stopPropagation();
            folderInputRef.current?.click();
          }}
        >
          <FolderUp className="size-3.5" />
        </Button>
      </div>

      {/* Hidden inputs */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleFileInputChange}
      />
      {/* webkitdirectory lets the user pick an entire folder */}
      <input
        ref={folderInputRef}
        type="file"
        multiple
        /* @ts-expect-error — webkitdirectory is not in React's typedefs */
        webkitdirectory=""
        className="hidden"
        onChange={handleFileInputChange}
      />

      {/* Error banner */}
      {error && (
        <div className="mx-3 mb-2 rounded-md bg-destructive/10 px-3 py-2 text-[11px] text-destructive">
          {error}
          <button
            className="ml-2 cursor-pointer underline"
            onClick={() => setError(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* File tree */}
      <div className="flex-1 overflow-y-auto">
        {files === undefined ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="size-4 animate-spin text-muted-foreground/50" />
          </div>
        ) : tree.length === 0 && uploading.size === 0 ? (
          <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
            <div className="flex size-10 items-center justify-center rounded-lg border border-dashed border-border bg-muted/30">
              <Upload className="size-4 text-muted-foreground/50" />
            </div>
            <div className="flex flex-col gap-1">
              <p className="text-[12px] font-medium text-foreground/70">
                No files yet
              </p>
              <p className="text-[11px] text-muted-foreground/60">
                Drop files or folders here, or use the buttons above.
              </p>
            </div>
          </div>
        ) : (
          <>
            {tree.map((node) => (
              <TreeRow
                key={node.path}
                node={node}
                depth={0}
                expanded={expanded}
                uploading={uploading}
                selected={selected}
                renamingPath={renamingPath}
                onSelect={setSelected}
                onToggle={toggleFolder}
                onDelete={handleDelete}
                onRenameStart={setRenamingPath}
                onRenameCommit={handleRenameCommit}
                onRenameCancel={() => setRenamingPath(null)}
              />
            ))}
            {/* In-flight uploads not yet reflected in DB */}
            {Array.from(uploading).map((path) => {
              const alreadyInTree = files?.some(
                (f: FileRecord) => f.path === path,
              );
              if (alreadyInTree) return null;
              const name = path.split("/").pop() ?? path;
              return (
                <div
                  key={`uploading-${path}`}
                  className="flex h-[22px] items-center gap-1.5 text-[12px] text-muted-foreground/60"
                  style={{ paddingLeft: "20px" }}
                >
                  <Loader2 className="size-3 animate-spin" />
                  <span className="truncate font-mono">{name}</span>
                </div>
              );
            })}
          </>
        )}
      </div>

      {/* Drag-over overlay */}
      {isDragOver && (
        <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 rounded bg-primary/5 backdrop-blur-[1px]">
          <div className="flex size-12 items-center justify-center rounded-full border-2 border-dashed border-primary/50 bg-background">
            <Upload className="size-5 text-primary/70" />
          </div>
          <p className="text-[12px] font-medium text-primary/80">
            Drop to upload
          </p>
        </div>
      )}

      {pendingDeleteNode && (
        <DeleteConfirmDialog
          open={pendingDeleteNode !== null}
          onOpenChange={(open) => {
            if (!open) setPendingDeleteNode(null);
          }}
          resourceName={pendingDeleteNode.name}
          resourceType={pendingDeleteNode.isFolder ? "folder" : "file"}
          critical={false}
          onConfirm={async () => {
            setIsDeletingNode(true);
            try {
              await executeDelete(pendingDeleteNode);
              setPendingDeleteNode(null);
            } finally {
              setIsDeletingNode(false);
            }
          }}
          isDeleting={isDeletingNode}
        />
      )}
    </div>
  );
}
