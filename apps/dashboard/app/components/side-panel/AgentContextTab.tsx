"use client";

/**
 * Context tab (ticket 18): the agent's desk. Working folders (create,
 * browse, upload, download, delete files), the Memory section
 * (memory/MEMORY.md — view, edit, clear), and detach — all against the real
 * `workspaceConfigs`/`config.workspaces` plumbing and the already-real
 * `workspaceFilesPublic` file actions.
 */

import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { Textarea } from "@/app/components/ui/textarea";
import {
  toNestedAgentConfig,
  type FlatAgentConfig,
} from "@/app/lib/agentConfigCodec";
import { toErrorMessage } from "@/app/lib/errors";
import { api } from "@broods/convex/_generated/api";
import type { Doc, Id } from "@broods/convex/_generated/dataModel";
import { useAction, useMutation } from "convex/react";
import {
  Brain,
  Download,
  Folder,
  FolderPlus,
  HardDrive,
  Loader2,
  RefreshCw,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Streamdown } from "streamdown";

interface WorkspaceRef {
  name?: string;
  workspaceId?: string;
}

interface FileEntry {
  path: string;
  name: string;
  isFolder: boolean;
  sizeBytes?: number;
  updatedAt?: string;
}

const MEMORY_PATH = "memory/MEMORY.md";

export function AgentContextTab({
  agentConfig,
  projectId,
}: {
  agentConfig: Doc<"agentConfigs"> | null | undefined;
  projectId: Id<"projects"> | undefined;
}): React.JSX.Element {
  const createWorkingFolder = useMutation(
    api.workspaceConfigsPublic.createWorkingFolder,
  );
  const detachWorkingFolder = useMutation(
    api.workspaceConfigsPublic.detachWorkingFolder,
  );

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("workspace");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { workspaces, sandbox } = useMemo(() => {
    if (!agentConfig)
      return { workspaces: [] as WorkspaceRef[], sandbox: null };
    const nested = toNestedAgentConfig(
      agentConfig as unknown as FlatAgentConfig,
    ) as Record<string, unknown>;

    return {
      workspaces: Array.isArray(nested.workspaces)
        ? (nested.workspaces as WorkspaceRef[])
        : [],
      sandbox: typeof nested.sandbox === "string" ? nested.sandbox : null,
    };
  }, [agentConfig]);

  if (agentConfig === undefined) {
    return (
      <div className="flex flex-1 items-center justify-center p-4">
        <p className="text-xs text-muted-foreground">Loading context…</p>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col gap-5 p-4">
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
            Working folders
          </span>
          {!creating && (
            <Button
              size="sm"
              variant="outline"
              className="h-6 gap-1 px-2 text-[11px]"
              onClick={() => setCreating(true)}
            >
              <FolderPlus className="size-3" />
              {workspaces.length === 0
                ? "Give this agent a folder"
                : "Add folder"}
            </Button>
          )}
        </div>

        {creating && (
          <div className="flex items-center gap-2">
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="folder name"
              className="h-7 flex-1 font-mono text-xs"
            />
            <Button
              size="sm"
              className="h-7 px-2 text-[11px]"
              disabled={busy || !newName.trim() || !agentConfig}
              onClick={() =>
                void (async () => {
                  if (!agentConfig) return;
                  setBusy(true);
                  setError(null);
                  try {
                    await createWorkingFolder({
                      configId: agentConfig._id,
                      name: newName.trim(),
                    });
                    setCreating(false);
                  } catch (err) {
                    setError(toErrorMessage(err));
                  } finally {
                    setBusy(false);
                  }
                })()
              }
            >
              {busy ? "Creating…" : "Create"}
            </Button>
            <Button
              size="icon-xs"
              variant="ghost"
              className="size-6"
              onClick={() => setCreating(false)}
            >
              <X className="size-3" />
            </Button>
          </div>
        )}

        {error && (
          <p className="rounded-md bg-destructive/10 px-2.5 py-2 text-xs text-destructive">
            {error}
          </p>
        )}

        {workspaces.length === 0 && !creating && (
          <div className="rounded-lg border border-border bg-muted/30 px-3 py-4">
            <p className="text-xs text-muted-foreground">
              The desk is empty. Give this agent a working folder — a place to
              share files with it and find the files it creates.
            </p>
          </div>
        )}

        {workspaces.map((workspace) =>
          workspace.workspaceId && projectId ? (
            <FolderCard
              key={workspace.workspaceId}
              projectId={projectId}
              workspaceId={workspace.workspaceId}
              name={workspace.name ?? "Unnamed folder"}
              onDetach={async () => {
                if (!agentConfig) return;
                await detachWorkingFolder({
                  configId: agentConfig._id,
                  workspaceId: workspace.workspaceId!,
                });
              }}
            />
          ) : null,
        )}
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
          Machine
        </span>
        {sandbox ? (
          <div className="flex items-start gap-2.5 rounded-lg border border-border bg-muted/20 px-3 py-2.5">
            <HardDrive className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-xs font-medium text-foreground">
                Sandbox attached
              </span>
              <span className="truncate font-mono text-[10px] text-muted-foreground">
                {sandbox}
              </span>
            </div>
          </div>
        ) : (
          <div className="rounded-lg border border-border bg-muted/30 px-3 py-4">
            <p className="text-xs text-muted-foreground">
              No machine yet. One is set up automatically when this agent gets
              its first working folder.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

/** One attached folder: files, memory, detach. */
function FolderCard({
  projectId,
  workspaceId,
  name,
  onDetach,
}: {
  projectId: Id<"projects">;
  workspaceId: string;
  name: string;
  onDetach: () => Promise<void>;
}) {
  const listFiles = useAction(api.workspaceFilesPublic.list);
  const uploadFile = useAction(api.workspaceFilesPublic.upload);
  const removeFile = useAction(api.workspaceFilesPublic.remove);
  const getDownloadUrl = useAction(api.workspaceFilesPublic.getDownloadUrl);

  const [files, setFiles] = useState<FileEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [confirmDetach, setConfirmDetach] = useState(false);
  const [confirmDeletePath, setConfirmDeletePath] = useState<string | null>(
    null,
  );
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const reload = useCallback(async () => {
    try {
      const rows = await listFiles({
        projectId: projectId,
        workspaceId: workspaceId,
      });
      setFiles(rows);
      setError(null);
    } catch (err) {
      setError(toErrorMessage(err));
    }
  }, [listFiles, projectId, workspaceId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const memoryFile = (files ?? []).find((file) => file.path === MEMORY_PATH);
  const visibleFiles = (files ?? []).filter(
    (file) => !file.isFolder && !file.path.startsWith("memory/"),
  );

  async function handleUpload(file: File | undefined) {
    if (!file) return;
    setBusyPath(file.name);
    setError(null);
    try {
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      await uploadFile({
        projectId: projectId,
        workspaceId: workspaceId,
        path: file.name,
        contentBase64: btoa(binary),
        ...(file.type ? { contentType: file.type } : {}),
      });
      await reload();
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setBusyPath(null);
    }
  }

  async function handleDownload(path: string) {
    setBusyPath(path);
    try {
      const url = await getDownloadUrl({
        projectId: projectId,
        workspaceId: workspaceId,
        path: path,
      });
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setBusyPath(null);
    }
  }

  async function handleDelete(path: string) {
    setBusyPath(path);
    setConfirmDeletePath(null);
    try {
      await removeFile({
        projectId: projectId,
        workspaceId: workspaceId,
        path: path,
      });
      await reload();
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setBusyPath(null);
    }
  }

  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-border bg-muted/20 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <Folder className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="flex-1 truncate text-xs font-medium text-foreground">
          {name}
        </span>
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          onChange={(e) => {
            void handleUpload(e.target.files?.[0]);
            e.currentTarget.value = "";
          }}
        />
        <Button
          size="icon-xs"
          variant="ghost"
          className="size-6 text-muted-foreground"
          title="Upload a file"
          onClick={() => fileInputRef.current?.click()}
        >
          <Upload className="size-3" />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          className="size-6 text-muted-foreground"
          title="Refresh"
          onClick={() => void reload()}
        >
          <RefreshCw className="size-3" />
        </Button>
        {confirmDetach ? (
          <>
            <Button
              size="sm"
              variant="destructive"
              className="h-6 px-2 text-[11px]"
              onClick={() => void onDetach()}
            >
              Detach?
            </Button>
            <Button
              size="icon-xs"
              variant="ghost"
              className="size-6"
              onClick={() => setConfirmDetach(false)}
            >
              <X className="size-3" />
            </Button>
          </>
        ) : (
          <Button
            size="icon-xs"
            variant="ghost"
            className="size-6 text-muted-foreground hover:text-red-500"
            title="Detach folder — the agent loses access to these files"
            onClick={() => setConfirmDetach(true)}
          >
            <Trash2 className="size-3" />
          </Button>
        )}
      </div>

      {error && (
        <p className="rounded-md bg-destructive/10 px-2.5 py-1.5 text-[11px] text-destructive">
          {error}
        </p>
      )}

      {files === null && !error && (
        <div className="flex items-center justify-center py-3">
          <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
        </div>
      )}

      {files !== null && visibleFiles.length === 0 && (
        <p className="text-[11px] text-muted-foreground">
          No files yet. Upload one, or ask the agent to save its work here.
        </p>
      )}

      {visibleFiles.map((file) => (
        <div
          key={file.path}
          className="flex items-center gap-2 rounded-md border border-border/60 bg-background/40 px-2 py-1.5"
        >
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate font-mono text-[11px] text-foreground">
              {file.path}
            </span>
            <span className="text-[10px] text-muted-foreground">
              {file.sizeBytes !== undefined ? formatBytes(file.sizeBytes) : ""}
              {file.updatedAt ? ` · ${formatWhen(file.updatedAt)}` : ""}
            </span>
          </div>
          {busyPath === file.path ? (
            <Loader2 className="size-3 animate-spin text-muted-foreground" />
          ) : (
            <>
              <Button
                size="icon-xs"
                variant="ghost"
                className="size-6 text-muted-foreground"
                title="Download"
                onClick={() => void handleDownload(file.path)}
              >
                <Download className="size-3" />
              </Button>
              {confirmDeletePath === file.path ? (
                <>
                  <Button
                    size="sm"
                    variant="destructive"
                    className="h-5 px-1.5 text-[10px]"
                    onClick={() => void handleDelete(file.path)}
                  >
                    Delete?
                  </Button>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="size-5"
                    onClick={() => setConfirmDeletePath(null)}
                  >
                    <X className="size-3" />
                  </Button>
                </>
              ) : (
                <Button
                  size="icon-xs"
                  variant="ghost"
                  className="size-6 text-muted-foreground hover:text-red-500"
                  title="Delete file"
                  onClick={() => setConfirmDeletePath(file.path)}
                >
                  <Trash2 className="size-3" />
                </Button>
              )}
            </>
          )}
        </div>
      ))}

      <MemorySection
        projectId={projectId}
        workspaceId={workspaceId}
        hasMemory={Boolean(memoryFile)}
        onChanged={() => void reload()}
      />
    </div>
  );
}

/** Memory: the agent's consolidated notes (memory/MEMORY.md). */
function MemorySection({
  projectId,
  workspaceId,
  hasMemory,
  onChanged,
}: {
  projectId: Id<"projects">;
  workspaceId: string;
  hasMemory: boolean;
  onChanged: () => void;
}) {
  const getDownloadUrl = useAction(api.workspaceFilesPublic.getDownloadUrl);
  const uploadFile = useAction(api.workspaceFilesPublic.upload);
  const removeFile = useAction(api.workspaceFilesPublic.remove);

  const [content, setContent] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const load = useCallback(async () => {
    if (!hasMemory) {
      setContent(null);

      return;
    }
    try {
      const url = await getDownloadUrl({
        projectId: projectId,
        workspaceId: workspaceId,
        path: MEMORY_PATH,
      });
      const response = await fetch(url);
      const text = response.ok ? await response.text() : "";
      setContent(text);
      setError(null);
    } catch (err) {
      setError(toErrorMessage(err));
    }
  }, [getDownloadUrl, hasMemory, projectId, workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveMemory(text: string) {
    setBusy(true);
    setError(null);
    try {
      await uploadFile({
        projectId: projectId,
        workspaceId: workspaceId,
        path: MEMORY_PATH,
        contentBase64: btoa(unescape(encodeURIComponent(text))),
        contentType: "text/markdown",
      });
      setContent(text);
      setEditing(false);
      onChanged();
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function clearMemory() {
    setBusy(true);
    setConfirmClear(false);
    setError(null);
    try {
      await removeFile({
        projectId: projectId,
        workspaceId: workspaceId,
        path: "memory",
      });
      setContent(null);
      onChanged();
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-1.5 border-t border-border/60 pt-2">
      <div className="flex items-center gap-1.5">
        <Brain className="size-3 text-muted-foreground" />
        <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
          Memory
        </span>
        <span className="flex-1" />
        {hasMemory && content !== null && !editing && (
          <>
            <Button
              size="sm"
              variant="ghost"
              className="h-5 px-1.5 text-[10px]"
              onClick={() => {
                setDraft(content);
                setEditing(true);
              }}
            >
              Edit
            </Button>
            {confirmClear ? (
              <>
                <Button
                  size="sm"
                  variant="destructive"
                  className="h-5 px-1.5 text-[10px]"
                  disabled={busy}
                  onClick={() => void clearMemory()}
                >
                  Clear memory?
                </Button>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  className="size-5"
                  onClick={() => setConfirmClear(false)}
                >
                  <X className="size-3" />
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                className="h-5 px-1.5 text-[10px] text-muted-foreground hover:text-red-500"
                onClick={() => setConfirmClear(true)}
              >
                Clear
              </Button>
            )}
          </>
        )}
      </div>

      {error && (
        <p className="rounded-md bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
          {error}
        </p>
      )}

      {!hasMemory && (
        <p className="text-[11px] text-muted-foreground">
          No memories yet — the agent saves things here as it learns about you.
        </p>
      )}

      {hasMemory && content === null && !error && (
        <Loader2 className="size-3 animate-spin text-muted-foreground" />
      )}

      {editing ? (
        <div className="flex flex-col gap-1.5">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            className="min-h-28 resize-y font-mono text-[11px]"
          />
          <div className="flex gap-1.5">
            <Button
              size="sm"
              className="h-6 px-2 text-[11px]"
              disabled={busy}
              onClick={() => void saveMemory(draft)}
            >
              {busy ? "Saving…" : "Save"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-[11px]"
              onClick={() => setEditing(false)}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        hasMemory &&
        content !== null && (
          <div className="max-h-48 overflow-auto rounded-md border border-border/60 bg-background/40 px-2.5 py-2">
            <Streamdown className="text-[11px] [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
              {content}
            </Streamdown>
          </div>
        )
      )}
    </div>
  );
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;

  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function formatWhen(iso: string): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return iso;

  return new Date(time).toLocaleString();
}
