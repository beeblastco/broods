"use client";

/** VSCode-style file explorer for a workspace canvas node with drag-and-drop upload. */
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { cn } from "@/app/lib/utils";
import { api } from "@filthy-panty/convex/_generated/api";
import type { Id } from "@filthy-panty/convex/_generated/dataModel";
import { useMutation, useQuery } from "convex/react";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  FolderUp,
  Loader2,
  Pencil,
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
  _id: Id<"workspaceFiles">;
  path: string;
  name: string;
  isFolder: boolean;
  storageId?: Id<"_storage">;
  mimeType?: string;
  sizeBytes?: number;
};

type FileNode = FileRecord & {
  children?: FileNode[];
};

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
}: {
  projectId: Id<"projects"> | undefined;
  nodeId: string;
}) {
  const files = useQuery(
    api.workspaceFiles.list,
    projectId ? { projectId: projectId, nodeId: nodeId } : "skip",
  );

  const generateUploadUrl = useMutation(api.workspaceFiles.generateUploadUrl);
  const createFile = useMutation(api.workspaceFiles.create);
  const removeFile = useMutation(api.workspaceFiles.remove);
  const removeFolderMut = useMutation(api.workspaceFiles.removeFolder);
  const renameMut = useMutation(api.workspaceFiles.rename);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [uploading, setUploading] = useState<Set<string>>(new Set());
  const [isDragOver, setIsDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dragCounter = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Deselect when clicking the blank area of the panel
  const handleContainerClick = useCallback(() => {
    setSelected(null);
    setRenamingPath(null);
  }, []);

  const handleDelete = useCallback(
    async (node: FileNode) => {
      if (!projectId) return;
      setSelected(null);
      if (node.isFolder) {
        await removeFolderMut({
          projectId: projectId,
          nodeId: nodeId,
          folderPath: node.path,
        });
      } else {
        await removeFile({ fileId: node._id });
      }
    },
    [projectId, nodeId, removeFile, removeFolderMut],
  );

  // Keyboard: Delete = delete selected, F2 = rename selected
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (renamingPath) return;
      if (
        (e.key === "Delete" || e.key === "Backspace") &&
        selected &&
        document.activeElement?.tagName !== "INPUT"
      ) {
        const match = files?.find((f: FileRecord) => f.path === selected);
        if (match) void handleDelete(match as FileNode);
      }
      if (e.key === "F2" && selected) {
        setRenamingPath(selected);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selected, renamingPath, files, handleDelete]);

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

        for (const { file, path } of entries) {
          try {
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
      } catch (err) {
        setError(err instanceof Error ? err.message : "Upload failed.");
      }
    },
    [projectId, nodeId, generateUploadUrl, createFile],
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
      await renameMut({ fileId: node._id, newName: newName });
    },
    [renameMut],
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
    </div>
  );
}
