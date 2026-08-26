"use client";

/**
 * Skills tab (ticket 17): the account's skill library — browse, search,
 * create, import, edit, rename, delete — plus the per-agent enable toggle
 * that writes the real ref into `extraConfig.skills.allowed`. A skill that
 * exists in the library but isn't enabled here IS the draft/review state;
 * no status column exists. The library's source of truth is S3 (the `skills`
 * table has no writers), served by `skillsPublic.listLibrary`.
 */

import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { Switch } from "@/app/components/ui/switch";
import { Textarea } from "@/app/components/ui/textarea";
import {
  readAgentBranch,
  type FlatAgentConfig,
} from "@/app/lib/agentConfigCodec";
import { matchesSkillRef, withoutSkillRef } from "@/app/lib/skillRefs";
import { toErrorMessage } from "@/app/lib/errors";
import { api } from "@broods/convex/_generated/api";
import type { Doc } from "@broods/convex/_generated/dataModel";
import { useAction, useMutation } from "convex/react";
import {
  AlertTriangle,
  ArrowLeft,
  BookOpen,
  GitBranch,
  Loader2,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Streamdown } from "streamdown";

interface SkillsBranch extends Record<string, unknown> {
  enabled?: boolean;
  allowed?: string[];
}

interface LibrarySkill {
  name: string;
  description?: string;
  path: string;
}

interface SkillDetail extends LibrarySkill {
  files: Array<{ path: string; size?: number }>;
  skillMd: string;
}

type View =
  | { kind: "list" }
  | { kind: "detail"; name: string }
  | { kind: "create" }
  | { kind: "github" };

export function AgentSkillsTab({
  agentConfig,
}: {
  agentConfig: Doc<"agentConfigs"> | null | undefined;
}): React.JSX.Element {
  const listLibrary = useAction(api.skillsPublic.listLibrary);
  const updateConfig = useMutation(api.agentConfig.update);

  const [library, setLibrary] = useState<LibrarySkill[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [view, setView] = useState<View>({ kind: "list" });
  const [search, setSearch] = useState("");

  const reload = useCallback(async () => {
    try {
      const rows = await listLibrary({});
      setLibrary(rows);
      setLoadError(null);
    } catch (err) {
      setLoadError(toErrorMessage(err));
    }
  }, [listLibrary]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const allowed = useMemo(() => {
    const branch = readAgentBranch<SkillsBranch>(
      agentConfig as FlatAgentConfig | undefined,
      "skills",
    );

    return Array.isArray(branch.allowed) ? branch.allowed : [];
  }, [agentConfig]);

  /** Merge-safe write of the skills.allowed list (never clobbers other branches). */
  const saveAllowed = useCallback(
    async (nextAllowed: string[]) => {
      if (!agentConfig) return;
      const currentExtra =
        (agentConfig.extraConfig as Record<string, unknown>) ?? {};
      const currentSkills =
        (currentExtra.skills as Record<string, unknown>) ?? {};
      await updateConfig({
        configId: agentConfig._id,
        extraConfig: {
          ...currentExtra,
          skills: { ...currentSkills, allowed: nextAllowed },
        },
      });
    },
    [agentConfig, updateConfig],
  );

  const isEnabled = useCallback(
    (skillName: string) =>
      allowed.some((ref) => matchesSkillRef(ref, skillName)),
    [allowed],
  );

  const toggleSkill = useCallback(
    async (skill: LibrarySkill, next: boolean) => {
      const cleaned = withoutSkillRef(allowed, skill.name);
      await saveAllowed(next ? [...cleaned, skill.path] : cleaned);
    },
    [allowed, saveAllowed],
  );

  // Allowed entries that resolve to no library skill (legacy garbage).
  const brokenRefs = useMemo(
    () =>
      library === null
        ? []
        : allowed.filter(
            (ref) => !library.some((skill) => matchesSkillRef(ref, skill.name)),
          ),
    [allowed, library],
  );

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!library) return [];
    if (!term) return library;

    return library.filter(
      (skill) =>
        skill.name.toLowerCase().includes(term) ||
        (skill.description ?? "").toLowerCase().includes(term),
    );
  }, [library, search]);

  if (view.kind === "detail") {
    return (
      <SkillDetailView
        name={view.name}
        enabled={isEnabled(view.name)}
        onBack={() => {
          setView({ kind: "list" });
          void reload();
        }}
        onDeleted={(name) => {
          setView({ kind: "list" });
          void saveAllowed(withoutSkillRef(allowed, name));
          void reload();
        }}
        onRenamed={(oldName, renamed) => {
          // Keep the agent's ref pointing at the skill across the rename.
          if (isEnabled(oldName)) {
            void saveAllowed([
              ...withoutSkillRef(allowed, oldName),
              renamed.path,
            ]);
          }
          setView({ kind: "detail", name: renamed.name });
          void reload();
        }}
      />
    );
  }

  if (view.kind === "create" || view.kind === "github") {
    return (
      <SkillCreateView
        mode={view.kind}
        onBack={() => {
          setView({ kind: "list" });
          void reload();
        }}
      />
    );
  }

  return (
    <div className="flex flex-1 flex-col gap-4 p-4">
      <div className="flex items-center gap-2">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search skills…"
          className="h-8 flex-1 text-xs"
        />
        <Button
          size="sm"
          variant="outline"
          className="h-8 gap-1 px-2 text-xs"
          onClick={() => setView({ kind: "github" })}
          title="Import from GitHub"
        >
          <GitBranch className="size-3" />
        </Button>
        <Button
          size="sm"
          className="h-8 gap-1 px-2.5 text-xs"
          onClick={() => setView({ kind: "create" })}
        >
          <Plus className="size-3" />
          New skill
        </Button>
      </div>

      {loadError && (
        <p className="rounded-md bg-destructive/10 px-2.5 py-2 text-xs text-destructive">
          {loadError}
        </p>
      )}

      {library === null && !loadError && (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        </div>
      )}

      {library !== null && library.length === 0 && (
        <div className="rounded-lg border border-border bg-muted/30 px-3 py-4">
          <p className="text-xs text-muted-foreground">
            No skills yet. Click New skill to teach this agent something — paste
            a tone guide, a checklist, a how-to — and flip it on.
          </p>
        </div>
      )}

      {filtered.map((skill) => (
        <div
          key={skill.path}
          className="flex items-start gap-2.5 rounded-lg border border-border bg-muted/20 px-3 py-2.5"
        >
          <BookOpen className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          <button
            type="button"
            className="flex min-w-0 flex-1 cursor-pointer flex-col gap-0.5 text-left"
            onClick={() => setView({ kind: "detail", name: skill.name })}
          >
            <span className="truncate text-xs font-medium text-foreground">
              {skill.name}
            </span>
            {skill.description && (
              <span className="line-clamp-2 text-[11px] text-muted-foreground">
                {skill.description}
              </span>
            )}
          </button>
          <div className="flex shrink-0 items-center gap-1.5 pt-0.5">
            <span className="text-[10px] text-muted-foreground">
              {isEnabled(skill.name) ? "On" : "Off"}
            </span>
            <Switch
              checked={isEnabled(skill.name)}
              onCheckedChange={(next) => void toggleSkill(skill, next)}
            />
          </div>
        </div>
      ))}

      {brokenRefs.length > 0 && (
        <div className="flex flex-col gap-2">
          <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
            Broken references
          </span>
          {brokenRefs.map((ref) => (
            <div
              key={ref}
              className="flex items-center gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2"
            >
              <AlertTriangle className="size-3.5 shrink-0 text-amber-500" />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-mono text-[11px] text-foreground">
                  {ref}
                </span>
                <span className="text-[11px] text-amber-600 dark:text-amber-400">
                  This name doesn&apos;t match any skill in your library.
                </span>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="h-6 shrink-0 px-2 text-[11px]"
                onClick={() =>
                  void saveAllowed(allowed.filter((r) => r !== ref))
                }
              >
                Remove
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Detail view: SKILL.md (rendered/raw/edit), files, rename, delete. */
function SkillDetailView({
  name,
  enabled,
  onBack,
  onDeleted,
  onRenamed,
}: {
  name: string;
  enabled: boolean;
  onBack: () => void;
  onDeleted: (name: string) => void;
  onRenamed: (oldName: string, renamed: { name: string; path: string }) => void;
}) {
  const getSkillDetail = useAction(api.skillsPublic.getSkillDetail);
  const updateSkillMd = useAction(api.skillsPublic.updateSkillMd);
  const renameSkill = useAction(api.skillsPublic.renameSkill);
  const deleteSkillByName = useAction(api.skillsPublic.deleteSkillByName);

  const [detail, setDetail] = useState<SkillDetail | null | "loading">(
    "loading",
  );
  const [error, setError] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState(name);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await getSkillDetail({ name: name });
      setDetail(result);
      setError(null);
      if (result) setEditText(result.skillMd);
    } catch (err) {
      setError(toErrorMessage(err));
      setDetail(null);
    }
  }, [getSkillDetail, name]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-1 flex-col gap-3 p-4">
      <div className="flex items-center gap-2">
        <Button
          size="icon-xs"
          variant="ghost"
          className="size-6 shrink-0"
          onClick={onBack}
          title="Back to library"
        >
          <ArrowLeft className="size-3.5" />
        </Button>
        {renaming ? (
          <>
            <Input
              value={renameDraft}
              onChange={(e) => setRenameDraft(e.target.value)}
              className="h-7 flex-1 font-mono text-xs"
            />
            <Button
              size="sm"
              className="h-7 px-2 text-[11px]"
              disabled={busy || !renameDraft.trim()}
              onClick={() =>
                void run(async () => {
                  const renamed = await renameSkill({
                    name: name,
                    newName: renameDraft.trim(),
                  });
                  setRenaming(false);
                  onRenamed(name, renamed);
                })
              }
            >
              Save
            </Button>
            <Button
              size="icon-xs"
              variant="ghost"
              className="size-6"
              onClick={() => setRenaming(false)}
            >
              <X className="size-3" />
            </Button>
          </>
        ) : (
          <>
            <span className="flex-1 truncate text-sm font-medium text-foreground">
              {name}
            </span>
            <span className="text-[10px] text-muted-foreground">
              {enabled ? "On for this agent" : "Off for this agent"}
            </span>
            <Button
              size="icon-xs"
              variant="ghost"
              className="size-6 text-muted-foreground"
              title="Rename"
              onClick={() => {
                setRenameDraft(name);
                setRenaming(true);
              }}
            >
              <Pencil className="size-3" />
            </Button>
            {confirmDelete ? (
              <>
                <Button
                  size="sm"
                  variant="destructive"
                  className="h-6 px-2 text-[11px]"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await deleteSkillByName({ name: name });
                      onDeleted(name);
                    })
                  }
                >
                  Delete?
                </Button>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  className="size-6"
                  onClick={() => setConfirmDelete(false)}
                >
                  <X className="size-3" />
                </Button>
              </>
            ) : (
              <Button
                size="icon-xs"
                variant="ghost"
                className="size-6 text-muted-foreground hover:text-red-500"
                title="Delete skill"
                onClick={() => setConfirmDelete(true)}
              >
                <Trash2 className="size-3" />
              </Button>
            )}
          </>
        )}
      </div>

      {error && (
        <p className="rounded-md bg-destructive/10 px-2.5 py-2 text-xs text-destructive">
          {error}
        </p>
      )}

      {detail === "loading" && (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        </div>
      )}

      {detail === null && !error && (
        <p className="text-xs text-muted-foreground">
          This skill no longer exists.
        </p>
      )}

      {detail !== null && detail !== "loading" && (
        <>
          {detail.description && (
            <p className="text-[11px] text-muted-foreground">
              {detail.description}
            </p>
          )}

          <div className="flex items-center gap-2">
            <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
              SKILL.md
            </span>
            <span className="flex-1" />
            {!editing && (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-[11px]"
                  onClick={() => setShowRaw((v) => !v)}
                >
                  {showRaw ? "Rendered" : "Raw"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 px-2 text-[11px]"
                  onClick={() => {
                    setEditText(detail.skillMd);
                    setEditing(true);
                  }}
                >
                  Edit
                </Button>
              </>
            )}
          </div>

          {editing ? (
            <div className="flex flex-col gap-2">
              <Textarea
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                spellCheck={false}
                className="min-h-52 resize-y font-mono text-xs"
              />
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  className="h-7 px-2.5 text-[11px]"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await updateSkillMd({ name: name, content: editText });
                      setEditing(false);
                      await load();
                    })
                  }
                >
                  {busy ? "Saving…" : "Save"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2.5 text-[11px]"
                  onClick={() => setEditing(false)}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : showRaw ? (
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/30 px-3 py-2 font-mono text-xs text-foreground">
              {detail.skillMd}
            </pre>
          ) : (
            <div className="max-h-80 overflow-auto rounded-md border border-border bg-muted/20 px-3 py-2">
              <Streamdown className="text-xs [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
                {detail.skillMd}
              </Streamdown>
            </div>
          )}

          {detail.files.length > 1 && (
            <div className="flex flex-col gap-1.5">
              <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
                Files
              </span>
              {detail.files.map((file) => (
                <div
                  key={file.path}
                  className="flex items-center justify-between rounded-md border border-border bg-muted/20 px-2.5 py-1.5"
                >
                  <span className="truncate font-mono text-[11px] text-foreground">
                    {file.path}
                  </span>
                  {file.size !== undefined && (
                    <span className="shrink-0 text-[10px] text-muted-foreground">
                      {formatBytes(file.size)}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** Create-new / import-from-GitHub views. */
function SkillCreateView({
  mode,
  onBack,
}: {
  mode: "create" | "github";
  onBack: () => void;
}) {
  const createFromJson = useAction(api.skillsPublic.createFromJson);
  const createFromGithub = useAction(api.skillsPublic.createFromGithub);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [content, setContent] = useState("");
  const [githubUrl, setGithubUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nameValid = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(name);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      if (mode === "create") {
        await createFromJson({
          name: name,
          description: description.trim(),
          content: content.trim(),
        });
      } else {
        await createFromGithub({ githubUrl: githubUrl.trim() });
      }
      onBack();
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-1 flex-col gap-3 p-4">
      <div className="flex items-center gap-2">
        <Button
          size="icon-xs"
          variant="ghost"
          className="size-6 shrink-0"
          onClick={onBack}
        >
          <ArrowLeft className="size-3.5" />
        </Button>
        <span className="text-sm font-medium text-foreground">
          {mode === "create" ? "New skill" : "Import from GitHub"}
        </span>
      </div>

      <p className="text-[11px] text-muted-foreground">
        {mode === "create"
          ? "Skills land in your library first — flip them on for this agent when you're ready."
          : "Point at a GitHub folder that contains a SKILL.md. The skill lands in your library, not yet enabled."}
      </p>

      {mode === "create" ? (
        <>
          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
              Name
            </span>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="reply-in-haiku"
              className="h-8 font-mono text-xs"
            />
            {name && !nameValid && (
              <span className="text-[11px] text-destructive">
                Lowercase letters, numbers, and hyphens only (max 64).
              </span>
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
              Description
            </span>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this skill does and when the agent should use it."
              rows={2}
              className="min-h-0 resize-y text-xs"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
              Instructions (SKILL.md body)
            </span>
            <Textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder={"When replying, always…"}
              spellCheck={false}
              className="min-h-40 resize-y font-mono text-xs"
            />
          </div>
        </>
      ) : (
        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
            GitHub URL
          </span>
          <Input
            value={githubUrl}
            onChange={(e) => setGithubUrl(e.target.value)}
            placeholder="https://github.com/owner/repo/tree/main/skill"
            className="h-8 font-mono text-xs"
          />
        </div>
      )}

      {error && (
        <p className="rounded-md bg-destructive/10 px-2.5 py-2 text-xs text-destructive">
          {error}
        </p>
      )}

      <Button
        size="sm"
        className="h-8 w-fit px-3 text-xs"
        disabled={
          busy ||
          (mode === "create"
            ? !nameValid || !description.trim() || !content.trim()
            : !githubUrl.trim())
        }
        onClick={() => void submit()}
      >
        {busy && <Loader2 className="mr-1 size-3 animate-spin" />}
        {mode === "create" ? "Create skill" : "Import"}
      </Button>
    </div>
  );
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;

  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
