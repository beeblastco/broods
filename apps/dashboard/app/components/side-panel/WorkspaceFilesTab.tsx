"use client";

/** VSCode-style file explorer for a workspace canvas node with drag-and-drop upload. */
import { DeleteConfirmDialog } from "@/app/components/DeleteConfirmDialog";
import { IconTooltip } from "@/app/components/IconTooltip";
import { Button } from "@/app/components/ui/button";
import { useOrgRole } from "@/app/hooks/useOrgRole";
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
  Pencil,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { StyleProps } from "react-file-icon";
import { FileIcon, defaultStyles } from "react-file-icon";
import { toErrorMessage } from "@/app/lib/errors";

export type FileRecord = {
  _id?: Id<"workspaceFiles">;
  path: string;
  name: string;
  isFolder: boolean;
  storageId?: Id<"_storage">;
  mimeType?: string;
  sizeBytes?: number;
  updatedAt?: string | number;
};

export type UploadEntry = { file: File; path: string };

type FileNode = FileRecord & {
  children?: FileNode[];
};

type RuntimeFileCacheEntry = {
  files: FileRecord[];
  cachedAt: number;
};

/** What a navigation key does on the focused row. */
type TreeKeyTarget = { focus: string } | { toggle: string };

const RUNTIME_FILE_CACHE_PREFIX = "broods.workspace-files.v1";
// How often the file list is re-read from core. Slow is fine: the focus and
// visibility refreshes cover active use.
const RUNTIME_FILES_POLL_MS = 15_000;
const runtimeFileCache = new Map<string, RuntimeFileCacheEntry>();

/** The workspace node's files from Convex or the runtime workspace, with upload, rename and delete. */
export function WorkspaceFilesTab({
  projectId,
  nodeId,
  workspaceId,
}: {
  projectId: Id<"projects"> | undefined;
  nodeId: string;
  workspaceId?: string;
}): React.JSX.Element {
  const { canWrite } = useOrgRole();
  const convexFiles = useQuery(
    api.workspace.files.list,
    projectId && !workspaceId
      ? { projectId: projectId, nodeId: nodeId }
      : "skip",
  );

  const generateUploadUrl = useMutation(api.workspace.files.generateUploadUrl);
  const createFile = useMutation(api.workspace.files.create);
  const removeFile = useMutation(api.workspace.files.remove);
  const removeFolderMut = useMutation(api.workspace.files.removeFolder);
  const renameMut = useMutation(api.workspace.files.rename);
  const listRuntimeFiles = useAction(api.workspace.filesPublic.list);
  const uploadRuntimeFile = useAction(api.workspace.filesPublic.upload);
  const removeRuntimePath = useAction(api.workspace.filesPublic.remove);
  const renameRuntimePath = useAction(api.workspace.filesPublic.rename);

  const cacheKey = runtimeFileCacheKey(projectId, workspaceId);
  const [runtimeFiles, setRuntimeFiles] = useState<FileRecord[] | undefined>(
    () => runtimeFileCache.get(cacheKey ?? "")?.files,
  );
  const [syncedWorkspaceId, setSyncedWorkspaceId] = useState(workspaceId);
  const [uploading, setUploading] = useState<Set<string>>(new Set());
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refreshRequestRef = useRef(0);
  const refreshPromiseRef = useRef<Promise<FileRecord[]> | undefined>(
    undefined,
  );

  if (workspaceId !== syncedWorkspaceId) {
    setSyncedWorkspaceId(workspaceId);
    setRuntimeFiles(readRuntimeFileCache(cacheKey)?.files);
  }

  const applyRuntimeFiles = useCallback(
    (next: FileRecord[]) => {
      writeRuntimeFileCache(cacheKey, next);
      setRuntimeFiles(next);
    },
    [cacheKey],
  );

  const refreshRuntimeFiles = useCallback(
    async (showIndicator = false, force = false) => {
      if (!projectId || !workspaceId) return;
      if (refreshPromiseRef.current && !force) return refreshPromiseRef.current;
      const request = ++refreshRequestRef.current;
      if (showIndicator) setIsRefreshing(true);
      const pending = listRuntimeFiles({
        projectId: projectId,
        workspaceId: workspaceId,
      });
      refreshPromiseRef.current = pending;
      try {
        const next = await pending;
        if (request === refreshRequestRef.current) applyRuntimeFiles(next);

        return next;
      } finally {
        if (refreshPromiseRef.current === pending)
          refreshPromiseRef.current = undefined;
        if (showIndicator) setIsRefreshing(false);
      }
    },
    [applyRuntimeFiles, listRuntimeFiles, projectId, workspaceId],
  );

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
    const pending = listRuntimeFiles({
      projectId: projectId,
      workspaceId: workspaceId,
    });
    refreshPromiseRef.current = pending;
    void pending
      .then((next) => {
        if (!cancelled && request === refreshRequestRef.current)
          // oxlint-disable-next-line no-callback-in-promise -- state applier, not an error-first callback.
          applyRuntimeFiles(next);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(toErrorMessage(err));
        if (!cached) setRuntimeFiles([]);
      })
      .finally(() => {
        if (refreshPromiseRef.current === pending)
          refreshPromiseRef.current = undefined;
      });

    return () => {
      cancelled = true;
    };
  }, [applyRuntimeFiles, cacheKey, listRuntimeFiles, projectId, workspaceId]);

  useEffect(() => {
    if (!workspaceId) return;
    const refreshWhenVisible = (): void => {
      if (document.visibilityState === "visible") {
        void refreshRuntimeFiles().catch(() => {});
      }
    };
    const interval = window.setInterval(
      refreshWhenVisible,
      RUNTIME_FILES_POLL_MS,
    );
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);

    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [refreshRuntimeFiles, workspaceId]);

  const files = workspaceId ? runtimeFiles : convexFiles;

  const handleDelete = useCallback(
    async (node: FileRecord) => {
      if (!projectId) return;
      if (workspaceId) {
        refreshRequestRef.current += 1;
        const optimistic = runtimeFiles
          ? withoutPath(runtimeFiles, node.path)
          : undefined;
        if (optimistic) applyRuntimeFiles(optimistic);
        try {
          await removeRuntimePath({
            projectId: projectId,
            workspaceId: workspaceId,
            path: node.path,
          });
        } catch (err) {
          setError(toErrorMessage(err));
        } finally {
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
    [
      applyRuntimeFiles,
      projectId,
      workspaceId,
      nodeId,
      removeFile,
      removeFolderMut,
      removeRuntimePath,
      refreshRuntimeFiles,
      runtimeFiles,
    ],
  );

  const uploadFiles = useCallback(
    async (entries: UploadEntry[], folders: string[]) => {
      if (!projectId) return;
      setError(null);

      setUploading((prev) => {
        const next = new Set(prev);
        for (const { path } of entries) next.add(path);

        return next;
      });

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

        // Failures are caught per entry: one bad file (too large, rejected)
        // must not abort the loop. That would strand the remaining paths in
        // `uploading` as permanent spinner rows and silently skip them.
        let entryError: string | null = null;
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
            });
          } catch (err) {
            entryError = toErrorMessage(err);
          } finally {
            setUploading((prev) => {
              const next = new Set(prev);
              next.delete(path);

              return next;
            });
          }
        }
        if (entryError) setError(entryError);
        if (workspaceId) await refreshRuntimeFiles(false, true);
      } catch (err) {
        setError(toErrorMessage(err));
        // The folder-creation path can fail before the loop starts; clear
        // every pending path so no row is left spinning forever.
        setUploading((prev) => {
          const next = new Set(prev);
          for (const { path } of entries) next.delete(path);

          return next;
        });
      }
    },
    [
      projectId,
      workspaceId,
      nodeId,
      generateUploadUrl,
      createFile,
      uploadRuntimeFile,
      refreshRuntimeFiles,
    ],
  );

  const handleRename = useCallback(
    async (node: FileRecord, newName: string) => {
      if (workspaceId && projectId) {
        const newPath = renamedPath(node.path, newName);
        refreshRequestRef.current += 1;
        const optimistic = runtimeFiles
          ? withRenamedPath(runtimeFiles, node.path, newPath)
          : undefined;
        if (optimistic) applyRuntimeFiles(optimistic);
        try {
          await renameRuntimePath({
            projectId: projectId,
            workspaceId: workspaceId,
            path: node.path,
            newPath: newPath,
          });
        } catch (err) {
          setError(toErrorMessage(err));
        } finally {
          await refreshRuntimeFiles(false, true);
        }

        return;
      }
      try {
        await renameMut({ fileId: node._id!, newName: newName });
      } catch (err) {
        setError(toErrorMessage(err));
      }
    },
    [
      applyRuntimeFiles,
      workspaceId,
      projectId,
      renameRuntimePath,
      refreshRuntimeFiles,
      renameMut,
      runtimeFiles,
    ],
  );

  return (
    <WorkspaceFilesView
      files={files}
      uploading={uploading}
      error={error}
      canWrite={canWrite}
      isRefreshing={isRefreshing}
      onRefresh={
        workspaceId
          ? () => {
              void refreshRuntimeFiles(true, true).catch((err) => {
                setError(toErrorMessage(err));
              });
            }
          : undefined
      }
      onDismissError={() => setError(null)}
      onUpload={uploadFiles}
      onDelete={handleDelete}
      onRename={handleRename}
    />
  );
}

/**
 * The explorer itself: toolbar, drop zone and a keyboard-navigable file tree.
 * Data-free so the UI gallery can render it. One row is the tab stop; arrows
 * move the selection, Enter toggles a folder, F2 renames and Delete asks first.
 */
export function WorkspaceFilesView({
  files,
  uploading,
  error,
  canWrite,
  isRefreshing = false,
  onRefresh,
  onDismissError,
  onUpload,
  onDelete,
  onRename,
}: {
  /** Undefined while loading. */
  files: FileRecord[] | undefined;
  uploading: Set<string>;
  error: string | null;
  canWrite: boolean;
  isRefreshing?: boolean;
  /** Shows the refresh button when set. */
  onRefresh?: () => void;
  onDismissError: () => void;
  onUpload: (entries: UploadEntry[], folders: string[]) => Promise<void>;
  onDelete: (node: FileRecord) => Promise<void>;
  onRename: (node: FileRecord, newName: string) => Promise<void>;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [pendingDeleteNode, setPendingDeleteNode] = useState<FileNode | null>(
    null,
  );
  const [isDeletingNode, setIsDeletingNode] = useState(false);
  const dragCounter = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  // The row that takes focus once a rename or a delete dialog ends, as soon as
  // it renders, unless the user already moved focus somewhere else.
  const pendingFocusRef = useRef<string | null>(null);

  const tree = useMemo(
    (): FileNode[] => (files ? buildTree(files) : []),
    [files],
  );
  const visible = useMemo(
    (): FileNode[] => visibleNodes(tree, expanded),
    [tree, expanded],
  );
  const tabStop = visible.some((node) => node.path === selected)
    ? selected
    : (visible[0]?.path ?? null);

  useEffect(() => {
    const path = pendingFocusRef.current;
    if (!path) return;
    if (document.activeElement && document.activeElement !== document.body) {
      pendingFocusRef.current = null;

      return;
    }
    // A Convex rename renders the new row only once its query catches up.
    const row = rowElement(treeRef.current, path);
    if (!row) return;
    pendingFocusRef.current = null;
    row.focus();
  });

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

  const upload = async (
    entries: UploadEntry[],
    folders: string[],
  ): Promise<void> => {
    if (folders.length > 0) {
      setExpanded((prev) => new Set([...prev, ...folders]));
    }
    await onUpload(entries, folders);
  };

  const handleDrop = async (
    e: React.DragEvent<HTMLDivElement>,
  ): Promise<void> => {
    e.preventDefault();
    dragCounter.current = 0;
    setIsDragOver(false);
    if (!canWrite) return;

    const fileEntries: UploadEntry[] = [];
    const folderPaths: string[] = [];
    // The drag data store closes once this handler first yields, so every
    // item is read before the first await.
    const dropped = Array.from(e.dataTransfer.items)
      .filter((item) => item.kind === "file")
      .map((item) => item.webkitGetAsEntry?.() ?? item.getAsFile());

    for (const entry of dropped) {
      if (entry instanceof File) {
        fileEntries.push({ file: entry, path: entry.name });
      } else if (entry) {
        await collectEntries(entry, "", fileEntries, folderPaths);
      }
    }

    await upload(fileEntries, folderPaths);
  };

  // A member's drop is refused rather than ignored: an uncancelled drop opens
  // the file in the tab and leaves the dashboard.
  const handleDragEnter = (e: React.DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    if (!canWrite) return;
    dragCounter.current += 1;
    setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    if (!canWrite) return;
    dragCounter.current -= 1;
    if (dragCounter.current === 0) setIsDragOver(false);
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    e.dataTransfer.dropEffect = canWrite ? "copy" : "none";
  };

  const handleFileInputChange = async (
    e: React.ChangeEvent<HTMLInputElement>,
  ): Promise<void> => {
    const picked = Array.from(e.target.files ?? []);
    if (!picked.length) return;

    const entries = picked.map((f) => ({
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

    await upload(entries, Array.from(folderSet));
    e.target.value = "";
  };

  const focusRow = (path: string): void => {
    setSelected(path);
    rowElement(treeRef.current, path)?.focus();
  };

  // Row clicks and keys are delegated here, so each row is a plain treeitem.
  // A row press, by click or Enter/Space: select it and toggle a folder.
  const activate = (node: FileNode): void => {
    setSelected(node.path);
    if (node.isFolder) toggleFolder(node.path);
  };

  const handleTreeClick = (e: React.MouseEvent<HTMLDivElement>): void => {
    const node = nodeAt(visible, e.target);
    if (!node) {
      setSelected(null);
      setRenamingPath(null);

      return;
    }
    activate(node);
  };

  const handleTreeKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    // Only a focused row: the rename input and row buttons keep their keys.
    const path =
      e.target instanceof HTMLElement ? e.target.dataset.path : undefined;
    const node = path ? visible.find((row) => row.path === path) : undefined;
    if (!node) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      activate(node);

      return;
    }
    if (canWrite && e.key === "F2") {
      e.preventDefault();
      setRenamingPath(node.path);

      return;
    }
    if (canWrite && (e.key === "Delete" || e.key === "Backspace")) {
      e.preventDefault();
      setPendingDeleteNode(node);

      return;
    }
    const target = treeKeyTarget(e.key, node, visible, expanded);
    if (!target) return;
    e.preventDefault();
    if ("focus" in target) focusRow(target.focus);
    else toggleFolder(target.toggle);
  };

  const endRename = (focusPath: string): void => {
    setRenamingPath(null);
    pendingFocusRef.current = focusPath;
  };

  const handleRenameCommit = (node: FileNode, newName: string): void => {
    const newPath = renamedPath(node.path, newName);
    setSelected(newPath);
    endRename(newPath);
    void onRename(node, newName);
  };

  return (
    <div
      className={cn(
        "relative flex flex-1 flex-col overflow-hidden",
        isDragOver && "ring-2 ring-inset ring-primary/50",
      )}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Toolbar */}
      <div className="flex shrink-0 items-center justify-end gap-0.5 px-3 py-2">
        {onRefresh && (
          <IconTooltip label="Refresh workspace files">
            <Button
              size="icon-xs"
              variant="ghost"
              className="cursor-pointer"
              disabled={isRefreshing}
              onClick={onRefresh}
            >
              <RefreshCw className="size-3.5" />
            </Button>
          </IconTooltip>
        )}
        {canWrite && (
          <>
            <IconTooltip label="Upload files">
              <Button
                size="icon-xs"
                variant="ghost"
                className="cursor-pointer"
                onClick={() => fileInputRef.current?.click()}
              >
                <Upload className="size-3.5" />
              </Button>
            </IconTooltip>
            <IconTooltip label="Upload folder">
              <Button
                size="icon-xs"
                variant="ghost"
                className="cursor-pointer"
                onClick={() => folderInputRef.current?.click()}
              >
                <FolderUp className="size-3.5" />
              </Button>
            </IconTooltip>
          </>
        )}
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
        /* @ts-expect-error webkitdirectory is not in React's typedefs */
        webkitdirectory=""
        className="hidden"
        onChange={handleFileInputChange}
      />

      {/* Error banner */}
      {error && (
        <div className="mx-3 mb-2 rounded-md bg-destructive/10 px-3 py-2 text-2xs text-destructive">
          {error}
          <button
            className="ml-2 cursor-pointer underline"
            onClick={onDismissError}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* File tree */}
      <div className="flex-1 overflow-y-auto">
        {files === undefined ? (
          <div className="flex items-center justify-center py-10">
            <span className="text-xs text-muted-foreground">Loading…</span>
          </div>
        ) : tree.length === 0 && uploading.size === 0 ? (
          <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
            <div className="flex size-10 items-center justify-center rounded-lg border border-dashed border-border bg-muted/30">
              <Upload className="size-4 text-muted-foreground" />
            </div>
            <div className="flex flex-col gap-1">
              <p className="text-xs font-medium text-foreground/70">
                No files yet
              </p>
              <p className="text-2xs text-muted-foreground">
                Drop files or folders here, or use the buttons above.
              </p>
            </div>
          </div>
        ) : (
          <div
            ref={treeRef}
            role="tree"
            aria-label="Workspace files"
            className="min-h-full"
            onClick={handleTreeClick}
            onKeyDown={handleTreeKeyDown}
          >
            {tree.map((node, index) => (
              <TreeRow
                key={node.path}
                node={node}
                depth={0}
                position={index + 1}
                setSize={tree.length}
                canWrite={canWrite}
                expanded={expanded}
                uploading={uploading}
                selected={selected}
                tabStop={tabStop}
                renamingPath={renamingPath}
                onDelete={setPendingDeleteNode}
                onRenameStart={setRenamingPath}
                onRenameCommit={handleRenameCommit}
                onRenameCancel={endRename}
              />
            ))}
            {/* In-flight uploads not yet reflected in DB */}
            {Array.from(uploading).map((path) => {
              const alreadyInTree = files.some((f) => f.path === path);
              if (alreadyInTree) return null;
              const name = path.split("/").pop() ?? path;

              return (
                <div
                  key={`uploading-${path}`}
                  role="treeitem"
                  aria-selected={false}
                  aria-disabled
                  aria-busy
                  className="flex h-5.5 items-center gap-1.5 pl-5 text-xs text-muted-foreground"
                >
                  <Upload className="size-3" />
                  <span className="truncate font-mono">{name}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Drag-over overlay */}
      {isDragOver && (
        <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 rounded bg-primary/5">
          <div className="flex size-12 items-center justify-center rounded-full border-2 border-dashed border-primary/50 bg-background">
            <Upload className="size-5 text-primary/70" />
          </div>
          <p className="text-xs font-medium text-primary/80">Drop to upload</p>
        </div>
      )}

      {pendingDeleteNode && (
        <DeleteConfirmDialog
          open={pendingDeleteNode !== null}
          onOpenChange={(open) => {
            if (open) return;
            // The dialog unmounts with this, before it can hand focus back.
            pendingFocusRef.current = pendingDeleteNode.path;
            setPendingDeleteNode(null);
          }}
          resourceName={pendingDeleteNode.name}
          resourceType={pendingDeleteNode.isFolder ? "folder" : "file"}
          critical={false}
          onConfirm={async () => {
            setIsDeletingNode(true);
            const next = rowAfterRemoval(visible, pendingDeleteNode.path);
            try {
              await onDelete(pendingDeleteNode);
              setSelected(next);
              pendingFocusRef.current = next;
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

  const sort = (nodes: FileNode[]): void => {
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

/** The row under a click or key event, by the `data-path` its treeitem carries. */
function nodeAt(
  visible: FileNode[],
  target: EventTarget,
): FileNode | undefined {
  if (!(target instanceof Element)) return undefined;
  const path = target.closest<HTMLElement>("[data-path]")?.dataset.path;

  return visible.find((node) => node.path === path);
}

/** The path a file or folder moves to when renamed in place. */
export function renamedPath(path: string, newName: string): string {
  const slash = path.lastIndexOf("/");

  return slash === -1 ? newName : `${path.slice(0, slash)}/${newName}`;
}

/** The row that takes over when a row and everything under it goes: the next one, else the one before. */
function rowAfterRemoval(visible: FileNode[], path: string): string | null {
  const index = visible.findIndex((node) => node.path === path);
  const after = visible
    .slice(index + 1)
    .find((node) => !node.path.startsWith(`${path}/`));

  return after?.path ?? visible[index - 1]?.path ?? null;
}

/** A row's treeitem element, by the `data-path` it carries. */
function rowElement(
  tree: HTMLElement | null,
  path: string,
): HTMLElement | null {
  return (
    tree?.querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"]`) ??
    null
  );
}

/** The WAI-ARIA tree moves: arrows walk the visible rows, Right and Left open, close and climb. */
function treeKeyTarget(
  key: string,
  node: FileNode,
  visible: FileNode[],
  expanded: Set<string>,
): TreeKeyTarget | undefined {
  const index = visible.indexOf(node);
  const isOpen = node.isFolder && expanded.has(node.path);
  const focus = (to: FileNode | undefined): TreeKeyTarget | undefined =>
    to ? { focus: to.path } : undefined;
  switch (key) {
    case "ArrowDown":
      return focus(visible[index + 1]);
    case "ArrowUp":
      return focus(visible[index - 1]);
    case "Home":
      return focus(visible[0]);
    case "End":
      return focus(visible.at(-1));
    case "ArrowRight":
      if (isOpen) return focus(node.children?.[0]);

      return node.isFolder ? { toggle: node.path } : undefined;
    case "ArrowLeft": {
      if (isOpen) return { toggle: node.path };
      const parent = node.path.slice(
        0,
        Math.max(node.path.lastIndexOf("/"), 0),
      );

      return focus(visible.find((row) => row.path === parent));
    }
    default:
      return undefined;
  }
}

/** The rows a user can reach: every root, and the children of open folders, in order. */
function visibleNodes(nodes: FileNode[], expanded: Set<string>): FileNode[] {
  return nodes.flatMap((node) =>
    node.children && expanded.has(node.path)
      ? [node, ...visibleNodes(node.children, expanded)]
      : [node],
  );
}

export function withoutPath(files: FileRecord[], path: string): FileRecord[] {
  return files.filter(
    (file) => file.path !== path && !file.path.startsWith(`${path}/`),
  );
}

export function withRenamedPath(
  files: FileRecord[],
  path: string,
  newPath: string,
): FileRecord[] {
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

function readRuntimeFileCache(
  key: string | undefined,
): RuntimeFileCacheEntry | undefined {
  if (!key) return undefined;
  const memory = runtimeFileCache.get(key);
  if (memory) return memory;
  if (typeof window === "undefined") return undefined;
  try {
    const raw = window.sessionStorage.getItem(
      `${RUNTIME_FILE_CACHE_PREFIX}:${key}`,
    );
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as RuntimeFileCacheEntry;
    if (!Array.isArray(parsed.files) || typeof parsed.cachedAt !== "number")
      return undefined;
    runtimeFileCache.set(key, parsed);

    return parsed;
  } catch {
    return undefined;
  }
}

function runtimeFileCacheKey(
  projectId: string | undefined,
  workspaceId: string | undefined,
): string | undefined {
  return projectId && workspaceId ? `${projectId}:${workspaceId}` : undefined;
}

function writeRuntimeFileCache(
  key: string | undefined,
  files: FileRecord[],
): void {
  if (!key) return;
  const entry = { files: files, cachedAt: Date.now() };
  runtimeFileCache.set(key, entry);
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(
      `${RUNTIME_FILE_CACHE_PREFIX}:${key}`,
      JSON.stringify(entry),
    );
  } catch {
    // Cache failures must never block workspace access.
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function collectEntries(
  entry: FileSystemEntry,
  parentPath: string,
  files: UploadEntry[],
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
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + chunkSize),
    );
  }

  return btoa(binary);
}

async function readAllEntries(
  reader: FileSystemDirectoryReader,
): Promise<FileSystemEntry[]> {
  const all: FileSystemEntry[] = [];
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => {
      reader.readEntries(resolve, reject);
    });
    if (batch.length === 0) break;
    all.push(...batch);
  }

  return all;
}

function ExtIcon({ name }: { name: string }): React.JSX.Element {
  const ext = name.includes(".")
    ? (name.split(".").pop()?.toLowerCase() ?? "")
    : "";
  const style: StyleProps =
    (defaultStyles as Record<string, StyleProps>)[ext] ?? {};

  return (
    <span className="mr-1.5 inline-flex size-3.5 shrink-0 items-center">
      <FileIcon extension={ext} {...style} />
    </span>
  );
}

function RenameInput({
  initialValue,
  onCommit,
  onCancel,
}: {
  initialValue: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState(initialValue);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.select();
  }, []);

  const commit = (): void => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== initialValue) {
      onCommit(trimmed);
    } else {
      onCancel();
    }
  };

  return (
    <input
      ref={ref}
      value={draft}
      aria-label={`Rename ${initialValue}`}
      className="h-4.5 w-full min-w-0 flex-1 rounded-sm border border-primary bg-transparent px-1 py-0 font-mono text-xs shadow-xs outline-none transition-shadow placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30"
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

function TreeRow({
  node,
  depth,
  position,
  setSize,
  canWrite,
  expanded,
  uploading,
  selected,
  tabStop,
  renamingPath,
  onDelete,
  onRenameStart,
  onRenameCommit,
  onRenameCancel,
}: {
  node: FileNode;
  depth: number;
  position: number;
  setSize: number;
  canWrite: boolean;
  expanded: Set<string>;
  uploading: Set<string>;
  selected: string | null;
  tabStop: string | null;
  renamingPath: string | null;
  onDelete: (node: FileNode) => void;
  onRenameStart: (path: string) => void;
  onRenameCommit: (node: FileNode, newName: string) => void;
  onRenameCancel: (path: string) => void;
}): React.JSX.Element {
  const isExpanded = expanded.has(node.path);
  const isSelected = selected === node.path;
  const isRenaming = renamingPath === node.path;
  const isUploading = uploading.has(node.path);

  return (
    <>
      <div
        role="treeitem"
        data-path={node.path}
        tabIndex={tabStop === node.path ? 0 : -1}
        aria-label={node.name}
        aria-level={depth + 1}
        aria-posinset={position}
        aria-setsize={setSize}
        aria-selected={isSelected}
        aria-expanded={node.isFolder ? isExpanded : undefined}
        aria-keyshortcuts={canWrite ? "F2 Delete" : undefined}
        className={cn(
          "group flex h-5.5 select-none items-center gap-0 pl-(--indent) pr-1 text-xs",
          "cursor-pointer outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
          isSelected
            ? "bg-accent text-accent-foreground"
            : "text-foreground/80 hover:bg-muted/50",
        )}
        style={{ "--indent": `${4 + depth * 16}px` }}
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
            <FolderOpen className="mr-1.5 size-3.5 shrink-0 text-folder" />
          ) : (
            <Folder className="mr-1.5 size-3.5 shrink-0 text-folder" />
          )
        ) : (
          <ExtIcon name={node.name} />
        )}

        {/* rename input, or the name with its size hint and actions */}
        {isRenaming ? (
          <RenameInput
            initialValue={node.name}
            onCommit={(newName) => onRenameCommit(node, newName)}
            onCancel={() => onRenameCancel(node.path)}
          />
        ) : (
          <>
            <span
              className="flex-1 truncate font-mono text-xs"
              onDoubleClick={(e) => {
                if (!canWrite) return;
                e.stopPropagation();
                onRenameStart(node.path);
              }}
            >
              {node.name}
            </span>

            {!node.isFolder && node.sizeBytes !== undefined && isSelected && (
              <span className="mr-1 shrink-0 text-3xs text-muted-foreground">
                {formatBytes(node.sizeBytes)}
              </span>
            )}

            {/* Pointer shortcuts, visible on hover or when selected. Out of the
                tab order: the tree has one tab stop and F2 / Delete do the same. */}
            <span
              className={cn(
                "flex shrink-0 items-center gap-0.5",
                isSelected
                  ? "opacity-100"
                  : "opacity-0 group-hover:opacity-100",
              )}
            >
              {isUploading ? (
                <Upload className="size-3.5 text-muted-foreground" />
              ) : canWrite ? (
                <>
                  <IconTooltip label={`Rename ${node.name}`}>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      tabIndex={-1}
                      className="size-5 cursor-pointer"
                      onClick={(e) => {
                        e.stopPropagation();
                        onRenameStart(node.path);
                      }}
                    >
                      <Pencil className="size-3.5" />
                    </Button>
                  </IconTooltip>
                  <IconTooltip label={`Delete ${node.name}`}>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      tone="destructive"
                      tabIndex={-1}
                      className="size-5 cursor-pointer"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDelete(node);
                      }}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </IconTooltip>
                </>
              ) : null}
            </span>
          </>
        )}
      </div>

      {/* children */}
      {node.isFolder &&
        isExpanded &&
        node.children?.map((child, index, siblings) => (
          <TreeRow
            key={child.path}
            node={child}
            depth={depth + 1}
            position={index + 1}
            setSize={siblings.length}
            canWrite={canWrite}
            expanded={expanded}
            uploading={uploading}
            selected={selected}
            tabStop={tabStop}
            renamingPath={renamingPath}
            onDelete={onDelete}
            onRenameStart={onRenameStart}
            onRenameCommit={onRenameCommit}
            onRenameCancel={onRenameCancel}
          />
        ))}
    </>
  );
}
