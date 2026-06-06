"use client";

/**
 * Skill card Details tab — source picker (Files / GitHub / JSON) on first open,
 * then source-specific configuration. Agent skills config (enabled + allowed) is
 * always shown at the bottom once a source is chosen.
 */
import { ToggleRow } from "@/app/components/side-panel/ConfigControls";
import { SectionHeader } from "@/app/components/side-panel/SectionHeader";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { Separator } from "@/app/components/ui/separator";
import { Textarea } from "@/app/components/ui/textarea";
import { useConnectedAgentConfig } from "@/app/hooks/useConnectedAgentConfig";
import {
    clearSkillsBearerToken,
    getSkillsBearerToken,
    setSkillsBearerToken,
} from "@/app/lib/skillsCredentials";
import { readAgentBranch, type FlatAgentConfig } from "@/app/lib/agentConfigCodec";
import { api } from "@/convex/_generated/api";
import { useAction } from "convex/react";
import { Eye, EyeOff, FolderOpen, GitBranch, Loader2, RotateCcw, Sparkles } from "lucide-react";
import { useMemo, useState } from "react";

type SkillSource = "files" | "github" | "json";

type SkillsSlice = {
    enabled?: boolean;
    allowed?: string[];
};

// ---------------------------------------------------------------------------
// Inner: token input (reused for both GitHub and JSON forms)
// ---------------------------------------------------------------------------

function TokenInput({
    value,
    onChange,
}: {
    value: string;
    onChange: (v: string) => void;
}) {
    const [show, setShow] = useState(false);

    return (
        <div className="flex items-center gap-1.5">
            <Input
                type={show ? "text" : "password"}
                value={value}
                placeholder="fp_acct_…"
                className="h-7 flex-1 font-mono text-[11px]"
                onChange={(e) => onChange(e.target.value)}
            />
            <Button
                size="icon-xs"
                variant="ghost"
                className="cursor-pointer"
                type="button"
                onClick={() => setShow((v) => !v)}
                aria-label={show ? "Hide token" : "Show token"}
            >
                {show ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
            </Button>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Inner: source picker cards
// ---------------------------------------------------------------------------

function SourceCard({
    icon,
    title,
    description,
    onClick,
}: {
    icon: React.ReactNode;
    title: string;
    description: string;
    onClick: () => void;
}) {
    return (
        <button
            className="flex cursor-pointer flex-col gap-1.5 rounded-lg border border-border bg-card p-3 text-left transition-colors hover:border-primary/40 hover:bg-muted/40"
            onClick={onClick}
        >
            <div className="flex items-center gap-2">
                <span className="text-muted-foreground">{icon}</span>
                <span className="text-xs font-medium text-foreground">{title}</span>
            </div>
            <p className="text-[11px] text-muted-foreground">{description}</p>
        </button>
    );
}

// ---------------------------------------------------------------------------
// Inner: GitHub import form
// ---------------------------------------------------------------------------

function GithubForm({
    onSuccess,
}: {
    onSuccess: (skillPath: string) => void;
}) {
    const createFromGithub = useAction(api.skillsPublic.createFromGithub);
    const [url, setUrl] = useState("");
    const [token, setToken] = useState(() => getSkillsBearerToken() ?? "");
    const [status, setStatus] = useState<{ type: "idle" | "busy" | "error"; message?: string }>({ type: "idle" });

    async function handleImport() {
        const trimmedUrl = url.trim();
        const trimmedToken = token.trim();
        if (!trimmedUrl || !trimmedToken) return;

        setSkillsBearerToken(trimmedToken);
        setStatus({ type: "busy" });
        try {
            const result = await createFromGithub({ bearerToken: trimmedToken, githubUrl: trimmedUrl });
            onSuccess(result.path);
        } catch (err) {
            const msg = err instanceof Error ? err.message : "Unknown error";
            if (msg.includes("Invalid Bearer token") || msg.includes("401")) {
                clearSkillsBearerToken();
                setToken("");
            }
            setStatus({ type: "error", message: msg });
        }
    }

    return (
        <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
                <SectionHeader>GitHub URL</SectionHeader>
                <p className="text-[11px] text-muted-foreground">
                    Format: <code className="rounded bg-muted px-1">https://github.com/&#123;owner&#125;/&#123;repo&#125;/tree/&#123;ref&#125;/&#123;path&#125;</code>
                </p>
                <Input
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    className="h-8 font-mono text-xs"
                    placeholder="https://github.com/owner/repo/tree/main/skill"
                />
            </div>

            <div className="flex flex-col gap-1.5">
                <SectionHeader>Account token</SectionHeader>
                <p className="text-[11px] text-muted-foreground">
                    Your filthy-panty Bearer token (starts with <code className="rounded bg-muted px-1">fp_acct_</code>). Saved in session only.
                </p>
                <TokenInput value={token} onChange={setToken} />
            </div>

            {status.type === "error" && (
                <p className="rounded-md bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
                    {status.message}
                </p>
            )}

            <Button
                size="sm"
                className="h-8 cursor-pointer gap-1.5 text-xs disabled:cursor-not-allowed"
                disabled={!url.trim() || !token.trim() || status.type === "busy"}
                onClick={() => void handleImport()}
            >
                {status.type === "busy" && <Loader2 className="size-3.5 animate-spin" />}
                Import from GitHub
            </Button>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Inner: JSON / quick-create form
// ---------------------------------------------------------------------------

function JsonForm({
    existingPath,
    onSuccess,
}: {
    existingPath?: string;
    onSuccess: (skillPath: string) => void;
}) {
    const createFromJson = useAction(api.skillsPublic.createFromJson);
    const [name, setName] = useState("");
    const [description, setDescription] = useState("");
    const [content, setContent] = useState("");
    const [token, setToken] = useState(() => getSkillsBearerToken() ?? "");
    const [status, setStatus] = useState<{ type: "idle" | "busy" | "success" | "error"; message?: string }>({ type: "idle" });

    const nameValid = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/.test(name) || /^[a-z0-9]$/.test(name);
    const canSubmit = nameValid && description.trim() && content.trim() && token.trim() && status.type !== "busy";
    const isUpdate = !!existingPath || status.type === "success";

    async function handleSubmit() {
        if (!canSubmit) return;
        setSkillsBearerToken(token.trim());
        setStatus({ type: "busy" });
        try {
            const result = await createFromJson({
                bearerToken: token.trim(),
                name: name,
                description: description.trim(),
                content: content.trim(),
            });
            setStatus({ type: "success", message: `Skill "${result.name}" saved.` });
            onSuccess(result.path);
        } catch (err) {
            const msg = err instanceof Error ? err.message : "Unknown error";
            if (msg.includes("Invalid Bearer token") || msg.includes("401")) {
                clearSkillsBearerToken();
                setToken("");
            }
            setStatus({ type: "error", message: msg });
        }
    }

    return (
        <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
                <SectionHeader>Skill name</SectionHeader>
                <p className="text-[11px] text-muted-foreground">
                    Lowercase letters, numbers, and hyphens. Max 64 characters.
                </p>
                <Input
                    value={name}
                    onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
                    className="h-8 font-mono text-xs"
                    placeholder="support-flow"
                    disabled={isUpdate}
                />
                {name && !nameValid && (
                    <p className="text-[11px] text-destructive">Must start and end with a letter or number.</p>
                )}
                {isUpdate && (
                    <p className="text-[11px] text-muted-foreground">
                        Name cannot be changed after creation. Use &ldquo;Change&rdquo; to start over.
                    </p>
                )}
            </div>

            <div className="flex flex-col gap-1.5">
                <SectionHeader>Description</SectionHeader>
                <Textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="What this skill does and when the agent should use it."
                    className="h-16 resize-none text-xs"
                />
            </div>

            <div className="flex flex-col gap-1.5">
                <SectionHeader>Instructions (SKILL.md)</SectionHeader>
                <p className="text-[11px] text-muted-foreground">
                    Markdown content that tells the agent how to apply this skill.
                </p>
                <Textarea
                    value={content}
                    onChange={(e) => setContent(e.target.value)}
                    placeholder="# My Skill&#10;&#10;When the user asks about X, you should..."
                    className="min-h-[100px] resize-y font-mono text-xs"
                />
            </div>

            <div className="flex flex-col gap-1.5">
                <SectionHeader>Account token</SectionHeader>
                <p className="text-[11px] text-muted-foreground">
                    Your filthy-panty Bearer token. Saved in session only.
                </p>
                <TokenInput value={token} onChange={setToken} />
            </div>

            {status.type === "error" && (
                <p className="rounded-md bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
                    {status.message}
                </p>
            )}

            {status.type === "success" && status.message && (
                <p className="rounded-md bg-emerald-500/10 px-2 py-1.5 text-[11px] text-emerald-600 dark:text-emerald-400">
                    {status.message}
                </p>
            )}

            <Button
                size="sm"
                className="h-8 cursor-pointer gap-1.5 text-xs disabled:cursor-not-allowed"
                disabled={!canSubmit}
                onClick={() => void handleSubmit()}
            >
                {status.type === "busy" && <Loader2 className="size-3.5 animate-spin" />}
                {isUpdate ? "Update skill" : "Create skill"}
            </Button>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/** Skill card Details tab — source picker then source-specific configuration. */
export function SkillDetailsTab({
    nodeId,
    nodeConfig,
    editName,
    setEditName,
    onSaveName,
    onUpdateNodeConfig,
    onUpdateSkillPath,
}: {
    nodeId: string;
    nodeConfig: Record<string, unknown> | undefined;
    editName: string;
    setEditName: (name: string) => void;
    onSaveName: () => void;
    onUpdateNodeConfig: (patch: Record<string, unknown>) => void;
    onUpdateSkillPath: (path: string) => void;
}) {
    const { agentConfig, updateBranch } = useConnectedAgentConfig(nodeId);
    const skills = useMemo(
        () => readAgentBranch<SkillsSlice>(agentConfig as FlatAgentConfig | undefined, "skills"),
        [agentConfig],
    );

    const skillSource = nodeConfig?.skillSource as SkillSource | undefined;
    const disabled = !agentConfig;
    const skillsEnabled = skills.enabled === true;
    const path = editName.trim();
    const inAllowed = path.length > 0 && (skills.allowed ?? []).includes(path);

    function setSource(source: SkillSource) {
        onUpdateNodeConfig({ skillSource: source });
    }

    function resetSource() {
        onUpdateNodeConfig({ skillSource: undefined });
    }

    /** Adds or removes this card's path from the agent's `skills.allowed` list. */
    function setIncluded(next: boolean) {
        const current = new Set(skills.allowed ?? []);
        if (next && path) {
            current.add(path);
        } else {
            current.delete(path);
        }
        const allowed = Array.from(current);

        void updateBranch(["skills", "allowed"], allowed.length > 0 ? allowed : undefined);
    }

    function handleSuccess(returnedPath: string) {
        onUpdateSkillPath(returnedPath);
    }

    // Source picker — shown when no source is set yet
    if (!skillSource) {
        return (
            <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-4">
                <div className="flex flex-col gap-1">
                    <SectionHeader>How do you want to add this skill?</SectionHeader>
                    <p className="text-[11px] text-muted-foreground">
                        Choose a source for this skill node.
                    </p>
                </div>

                <div className="flex flex-col gap-2">
                    <SourceCard
                        icon={<FolderOpen className="size-4" />}
                        title="Upload files"
                        description="Upload and manage skill files locally, then publish to your filthy-panty account."
                        onClick={() => setSource("files")}
                    />
                    <SourceCard
                        icon={<GitBranch className="size-4" />}
                        title="GitHub repository"
                        description="Import directly from a GitHub repository URL. filthy-panty fetches and stores the files."
                        onClick={() => setSource("github")}
                    />
                    <SourceCard
                        icon={<Sparkles className="size-4" />}
                        title="Quick create"
                        description="Write a simple skill with a name, description, and instructions. Published directly."
                        onClick={() => setSource("json")}
                    />
                </div>
            </div>
        );
    }

    return (
        <div className="flex flex-1 flex-col gap-5 overflow-y-auto p-4">
            {/* Source-specific configuration */}
            {skillSource === "files" && (
                <div className="flex flex-col gap-3">
                    <div className="flex items-center justify-between">
                        <SectionHeader>File upload</SectionHeader>
                        <button
                            className="flex cursor-pointer items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                            onClick={resetSource}
                            title="Change source type"
                        >
                            <RotateCcw className="size-3" />
                            Change
                        </button>
                    </div>
                    <div className="rounded-lg border border-dashed border-border bg-muted/20 px-3 py-4 text-center">
                        <p className="text-xs font-medium text-foreground/80">Upload skill files in the Files tab</p>
                        <p className="mt-1 text-[11px] text-muted-foreground">
                            Switch to the <span className="font-medium text-foreground/60">Files</span> tab to upload your skill bundle. Add a <code className="rounded bg-muted px-1">SKILL.md</code> at the root, then publish.
                        </p>
                    </div>
                    {path && (
                        <>
                            <SectionHeader>Skill path</SectionHeader>
                            <p className="text-[11px] text-muted-foreground">
                                Set after publishing. Format: <code className="rounded bg-muted px-1">accountId/skill-name</code>.
                            </p>
                            <Input
                                value={editName}
                                onChange={(e) => setEditName(e.target.value)}
                                className="h-8 font-mono text-xs"
                                placeholder="acct_abc/support-flow"
                                onBlur={onSaveName}
                                onKeyDown={(e) => {
                                    if (e.key === "Enter") onSaveName();
                                }}
                            />
                        </>
                    )}
                </div>
            )}

            {skillSource === "github" && (
                <div className="flex flex-col gap-3">
                    <div className="flex items-center justify-between">
                        <SectionHeader>Import from GitHub</SectionHeader>
                        <button
                            className="flex cursor-pointer items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                            onClick={resetSource}
                            title="Change source type"
                        >
                            <RotateCcw className="size-3" />
                            Change
                        </button>
                    </div>

                    {path && (
                        <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-2.5 py-1.5">
                            <code className="flex-1 text-xs text-foreground">{path}</code>
                        </div>
                    )}

                    <GithubForm onSuccess={handleSuccess} />
                </div>
            )}

            {skillSource === "json" && (
                <div className="flex flex-col gap-3">
                    <div className="flex items-center justify-between">
                        <SectionHeader>Quick create</SectionHeader>
                        <button
                            className="flex cursor-pointer items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                            onClick={resetSource}
                            title="Change source type"
                        >
                            <RotateCcw className="size-3" />
                            Change
                        </button>
                    </div>

                    {path && (
                        <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-2.5 py-1.5">
                            <code className="flex-1 text-xs text-foreground">{path}</code>
                        </div>
                    )}

                    <JsonForm existingPath={path || undefined} onSuccess={handleSuccess} />
                </div>
            )}

            <Separator />

            {/* Agent skills config — common to all sources */}
            {disabled && (
                <p className="text-xs text-muted-foreground">Wire this skill to an agent to configure it.</p>
            )}

            <div className="flex flex-col gap-3">
                <SectionHeader>Skills</SectionHeader>
                <ToggleRow
                    label="Enabled"
                    description="Master switch for the agent's skills."
                    checked={skillsEnabled}
                    disabled={disabled}
                    onCheckedChange={(next) => updateBranch(["skills", "enabled"], next)}
                />
                <ToggleRow
                    label="This skill allowed"
                    description="Include this skill in the agent's allowed list."
                    checked={inAllowed}
                    disabled={disabled || !skillsEnabled || !path}
                    onCheckedChange={setIncluded}
                />
            </div>
        </div>
    );
}
