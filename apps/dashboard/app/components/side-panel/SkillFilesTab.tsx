"use client";

/**
 * Skill file explorer — wraps WorkspaceFilesTab with filthy-panty skill format
 * constraints: SKILL.md at root required, text files only, 5 MB per file /
 * 30 MB total. Publish action pushes the files to the filthy-panty account.
 */
import { WorkspaceFilesTab } from "@/app/components/side-panel/WorkspaceFilesTab";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { Separator } from "@/app/components/ui/separator";
import { Textarea } from "@/app/components/ui/textarea";
import {
  clearSkillsBearerToken,
  getSkillsBearerToken,
  setSkillsBearerToken,
} from "@/app/lib/skillsCredentials";
import { api } from "@filthy-panty/convex/_generated/api";
import type { Id } from "@filthy-panty/convex/_generated/dataModel";
import { useAction, useMutation, useQuery } from "convex/react";
import {
  AlertTriangle,
  BookOpen,
  Eye,
  EyeOff,
  Loader2,
  Send,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ALLOWED_EXTENSIONS = new Set([
  "css",
  "csv",
  "html",
  "js",
  "json",
  "md",
  "mjs",
  "py",
  "sh",
  "sql",
  "svg",
  "toml",
  "ts",
  "tsx",
  "txt",
  "xml",
  "yaml",
  "yml",
]);

function parseSkillMd(text: string): { name?: string; description?: string } {
  const match = text.match(/^---\n([\s\S]+?)\n---/);
  if (!match) return {};
  const fm = match[1];
  const name = fm.match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const desc = fm.match(/^description:\s*(.+)$/m)?.[1]?.trim();
  return { name: name, description: desc };
}

function buildSkillMdContent(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nDescribe what this skill does and when the agent should use it.\n`;
}

// ---------------------------------------------------------------------------
// Bearer token prompt (inline, not a modal)
// ---------------------------------------------------------------------------

function TokenPrompt({
  label,
  onConfirm,
  onCancel,
}: {
  label: string;
  onConfirm: (token: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [show, setShow] = useState(false);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3 shadow-md">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium text-foreground">{label}</span>
        <button
          className="cursor-pointer text-muted-foreground hover:text-foreground"
          onClick={onCancel}
        >
          <X className="size-3.5" />
        </button>
      </div>
      <p className="text-[10px] text-muted-foreground">
        Your filthy-panty Bearer token (starts with <code>fp_acct_</code>).
        Saved in session only.
      </p>
      <div className="flex items-center gap-1.5">
        <Input
          ref={ref}
          type={show ? "text" : "password"}
          value={draft}
          placeholder="fp_acct_…"
          className="h-7 flex-1 font-mono text-[11px]"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && draft.trim()) onConfirm(draft.trim());
            if (e.key === "Escape") onCancel();
          }}
        />
        <Button
          size="icon-xs"
          variant="ghost"
          className="cursor-pointer"
          onClick={() => setShow((v) => !v)}
        >
          {show ? (
            <EyeOff className="size-3.5" />
          ) : (
            <Eye className="size-3.5" />
          )}
        </Button>
      </div>
      <Button
        size="sm"
        className="h-7 cursor-pointer self-end text-[11px] disabled:cursor-not-allowed"
        disabled={!draft.trim()}
        onClick={() => onConfirm(draft.trim())}
      >
        Confirm
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create SKILL.md wizard
// ---------------------------------------------------------------------------

function CreateSkillMdForm({
  onSubmit,
  onCancel,
}: {
  onSubmit: (name: string, description: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const nameValid =
    /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/.test(name) || /^[a-z0-9]$/.test(name);

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3 shadow-md">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium text-foreground">
          Create SKILL.md
        </span>
        <button
          className="cursor-pointer text-muted-foreground hover:text-foreground"
          onClick={onCancel}
        >
          <X className="size-3.5" />
        </button>
      </div>
      <p className="text-[10px] text-muted-foreground">
        Lowercase letters, numbers, hyphens. Required at the bundle root.
      </p>
      <div className="flex flex-col gap-1">
        <label className="text-[10px] text-muted-foreground">Skill name</label>
        <Input
          value={name}
          placeholder="support-flow"
          className="h-7 font-mono text-[11px]"
          onChange={(e) =>
            setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))
          }
        />
        {name && !nameValid && (
          <p className="text-[10px] text-destructive">
            Name must start and end with a letter or number.
          </p>
        )}
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-[10px] text-muted-foreground">Description</label>
        <Textarea
          value={desc}
          placeholder="What this skill does and when to use it."
          className="h-16 resize-none text-[11px]"
          onChange={(e) => setDesc(e.target.value)}
        />
      </div>
      <Button
        size="sm"
        className="h-7 cursor-pointer self-end text-[11px] disabled:cursor-not-allowed"
        disabled={!nameValid || !desc.trim()}
        onClick={() => onSubmit(name, desc.trim())}
      >
        Create
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

/** Skill file explorer with publish/import against the filthy-panty account-manage API. */
export function SkillFilesTab({
  projectId,
  nodeId,
  skillPath,
  onUpdateSkillPath,
}: {
  projectId: Id<"projects"> | undefined;
  nodeId: string;
  skillPath: string;
  onUpdateSkillPath: (path: string) => void;
}) {
  const files = useQuery(
    api.workspaceFiles.list,
    projectId ? { projectId: projectId, nodeId: nodeId } : "skip",
  );
  const skillMdUrl = useQuery(
    api.workspaceFiles.getFileDownloadUrl,
    projectId
      ? { projectId: projectId, nodeId: nodeId, path: "SKILL.md" }
      : "skip",
  );

  const publishSkill = useAction(api.skillsPublic.publishSkill);
  const generateUploadUrl = useMutation(api.workspaceFiles.generateUploadUrl);
  const createFile = useMutation(api.workspaceFiles.create);

  const [skillMeta, setSkillMeta] = useState<{
    name?: string;
    description?: string;
  } | null>(null);
  const [status, setStatus] = useState<{
    type: "idle" | "publishing" | "success" | "error";
    message?: string;
  }>({ type: "idle" });
  const [promptMode, setPromptMode] = useState<"publish" | null>(null);
  const [showCreateSkillMd, setShowCreateSkillMd] = useState(false);

  const [syncedSkillMdUrl, setSyncedSkillMdUrl] = useState(skillMdUrl);

  // Clear parsed metadata when SKILL.md disappears (set during render so the
  // effect below only performs the async fetch, never a synchronous setState).
  if (skillMdUrl !== syncedSkillMdUrl) {
    setSyncedSkillMdUrl(skillMdUrl);
    if (!skillMdUrl) setSkillMeta(null);
  }

  // Fetch and parse SKILL.md whenever its URL changes
  useEffect(() => {
    if (!skillMdUrl) return;
    let cancelled = false;
    fetch(skillMdUrl)
      .then((r) => r.text())
      .then((text) => {
        if (!cancelled) {
          const meta = parseSkillMd(text);
          setSkillMeta(meta);
          // Auto-update the skill path when SKILL.md name changes
          if (meta.name) {
            const accountPart = skillPath.includes("/")
              ? skillPath.split("/")[0]
              : "";
            const newPath = accountPart
              ? `${accountPart}/${meta.name}`
              : meta.name;
            if (newPath !== skillPath) onUpdateSkillPath(newPath);
          }
        }
      })
      .catch(() => {
        if (!cancelled) setSkillMeta(null);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skillMdUrl]);

  const hasSkillMd = (files ?? []).some((f) => f.path === "SKILL.md");
  const unsupportedFiles = (files ?? []).filter((f) => {
    if (f.isFolder) return false;
    const ext = f.name.includes(".")
      ? (f.name.split(".").pop()?.toLowerCase() ?? "")
      : "";
    return ext && !ALLOWED_EXTENSIONS.has(ext);
  });

  const runWithToken = useCallback(
    async (token: string) => {
      if (!projectId) return;
      setSkillsBearerToken(token);
      setPromptMode(null);
      setStatus({ type: "publishing" });

      try {
        const result = await publishSkill({
          projectId: projectId,
          nodeId: nodeId,
          bearerToken: token,
        });
        setStatus({
          type: "success",
          message: `Published "${result.name}" successfully.`,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        if (msg.includes("Invalid Bearer token") || msg.includes("401")) {
          clearSkillsBearerToken();
        }
        setStatus({ type: "error", message: msg });
      }
    },
    [projectId, nodeId, publishSkill],
  );

  const handlePublishClick = useCallback(() => {
    const token = getSkillsBearerToken();
    if (token) {
      void runWithToken(token);
    } else {
      setPromptMode("publish");
    }
  }, [runWithToken]);

  const handleCreateSkillMd = useCallback(
    async (name: string, description: string) => {
      if (!projectId) return;
      setShowCreateSkillMd(false);

      const content = buildSkillMdContent(name, description);
      const file = new File([content], "SKILL.md", { type: "text/markdown" });

      const uploadUrl = await generateUploadUrl();
      const res = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": "text/markdown" },
        body: file,
      });
      if (!res.ok) return;

      const { storageId } = (await res.json()) as { storageId: Id<"_storage"> };
      await createFile({
        projectId: projectId,
        nodeId: nodeId,
        path: "SKILL.md",
        name: "SKILL.md",
        isFolder: false,
        storageId: storageId,
        mimeType: "text/markdown",
        sizeBytes: file.size,
      });
    },
    [projectId, nodeId, generateUploadUrl, createFile],
  );

  const isBusy = status.type === "publishing";

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* SKILL.md info bar */}
      {skillMeta && (
        <div className="flex shrink-0 flex-col gap-0.5 border-b border-border bg-muted/20 px-3 py-2">
          <div className="flex items-center gap-1.5">
            <BookOpen className="size-3 text-muted-foreground/60" />
            <span className="font-mono text-[12px] font-medium text-foreground/80">
              {skillMeta.name ?? "—"}
            </span>
          </div>
          {skillMeta.description && (
            <p className="text-[10px] text-muted-foreground/70">
              {skillMeta.description}
            </p>
          )}
        </div>
      )}

      {/* SKILL.md missing warning */}
      {files !== undefined && !hasSkillMd && (
        <div className="flex shrink-0 items-center gap-2 border-b border-amber-500/20 bg-amber-500/5 px-3 py-1.5">
          <AlertTriangle className="size-3 shrink-0 text-amber-500" />
          <span className="flex-1 text-[10px] text-amber-600 dark:text-amber-400">
            SKILL.md required at the root
          </span>
          <button
            className="cursor-pointer text-[10px] font-medium text-amber-600 underline dark:text-amber-400"
            onClick={() => setShowCreateSkillMd(true)}
          >
            Create
          </button>
        </div>
      )}

      {/* Unsupported file types warning */}
      {unsupportedFiles.length > 0 && (
        <div className="flex shrink-0 items-center gap-2 border-b border-destructive/20 bg-destructive/5 px-3 py-1.5">
          <AlertTriangle className="size-3 shrink-0 text-destructive" />
          <span className="text-[10px] text-destructive">
            {unsupportedFiles.length} unsupported file type
            {unsupportedFiles.length > 1 ? "s" : ""} — skill bundles are
            text-only
          </span>
        </div>
      )}

      {/* Create SKILL.md form */}
      {showCreateSkillMd && (
        <div className="shrink-0 p-2">
          <CreateSkillMdForm
            onSubmit={handleCreateSkillMd}
            onCancel={() => setShowCreateSkillMd(false)}
          />
        </div>
      )}

      {/* Core file tree — reuses WorkspaceFilesTab */}
      <div
        id={`skill-files-${nodeId}`}
        className="flex min-h-0 flex-1 flex-col overflow-hidden"
      >
        <WorkspaceFilesTab projectId={projectId} nodeId={nodeId} />
      </div>

      <Separator />

      {/* Token prompt */}
      {promptMode && (
        <div className="shrink-0 p-2">
          <TokenPrompt
            label="Bearer token to publish"
            onConfirm={(token) => void runWithToken(token)}
            onCancel={() => setPromptMode(null)}
          />
        </div>
      )}

      {/* Status message */}
      {status.type !== "idle" && status.message && (
        <div
          className={`shrink-0 flex items-center gap-2 px-3 py-1.5 text-[11px] ${
            status.type === "error"
              ? "bg-destructive/10 text-destructive"
              : "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
          }`}
        >
          <span className="flex-1">{status.message}</span>
          <button
            className="cursor-pointer"
            onClick={() => setStatus({ type: "idle" })}
          >
            <X className="size-3" />
          </button>
        </div>
      )}

      {/* Action bar */}
      {!promptMode && (
        <div className="flex shrink-0 items-center gap-1.5 px-3 py-2">
          <Button
            size="sm"
            variant="outline"
            className="h-7 flex-1 cursor-pointer gap-1.5 text-[11px] disabled:cursor-not-allowed"
            disabled={isBusy || !hasSkillMd}
            title={!hasSkillMd ? "SKILL.md is required" : undefined}
            onClick={handlePublishClick}
          >
            {status.type === "publishing" ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <Send className="size-3" />
            )}
            Publish to account
          </Button>
          {getSkillsBearerToken() && (
            <Button
              size="icon-xs"
              variant="ghost"
              className="size-7 cursor-pointer text-muted-foreground"
              title="Clear saved Bearer token"
              onClick={() => clearSkillsBearerToken()}
            >
              <X className="size-3" />
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
