"use client";

/**
 * Workspace card Details tab — mirrors filthy-panty's nested AgentWorkspaceConfig
 * (enabled / needsApproval / memory / tasks / storage / sandbox). Every control
 * auto-saves through the connected agent's `extraConfig.workspace.*` slice; each
 * feature is a single toggle (no redundant "enabled" row) and reveals its extra
 * configuration inline when switched on, matching the Agent card's design.
 */
import { SectionHeader } from "@/app/components/side-panel/SectionHeader";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/app/components/ui/select";
import { Separator } from "@/app/components/ui/separator";
import { Switch } from "@/app/components/ui/switch";
import { useConnectedAgentConfig } from "@/app/hooks/useConnectedAgentConfig";
import { readAgentBranch, type FlatAgentConfig } from "@/app/lib/agentConfigCodec";
import { isRecord } from "@/app/lib/utils";
import { Plus, Trash2 } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

/** Slice of the nested agent config edited by this tab. */
type WorkspaceSlice = {
    enabled?: boolean;
    needsApproval?: boolean;
    memory?: { enabled?: boolean; namespace?: string };
    tasks?: { enabled?: boolean };
    storage?: { provider?: string };
    sandbox?: SandboxSlice;
};

/** Per-sandbox configuration nested under `workspace.sandbox`. */
type SandboxSlice = {
    provider?: "lambda" | "e2b" | "daytona";
    timeout?: number;
    memoryLimit?: number;
    outputLimitBytes?: number;
    options?: Record<string, unknown>;
};

/** Writes a value at a nested path of the connected agent config. */
type UpdateBranch = (path: ReadonlyArray<string>, value: unknown) => Promise<void> | void;

/** Workspace card Details tab — auto-saving editor for the connected agent's workspace config. */
export function WorkspaceDetailsTab(props: {
    nodeId: string;
    editName: string;
    setEditName: (name: string) => void;
    onSaveName: () => void;
}) {
    const { nodeId, editName, setEditName, onSaveName } = props;
    const { agentConfig, updateBranch } = useConnectedAgentConfig(nodeId);
    const workspace = useMemo(
        () => readAgentBranch<WorkspaceSlice>(agentConfig as FlatAgentConfig | undefined, "workspace"),
        [agentConfig],
    );
    const disabled = !agentConfig;
    const workspaceEnabled = workspace.enabled !== false;

    return (
        <div className="flex flex-1 flex-col gap-5 overflow-y-auto p-4">
            {/* Editable name — auto-saves on blur / Enter */}
            <div className="flex flex-col gap-1.5">
                <SectionHeader>Name</SectionHeader>
                <Input
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    className="h-8 text-sm"
                    onBlur={onSaveName}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") onSaveName();
                    }}
                />
            </div>

            <Separator />

            {disabled && (
                <p className="text-xs text-muted-foreground">
                    Wire this workspace to an agent to edit its configuration.
                </p>
            )}

            {/* Workspace master controls */}
            <div className="flex flex-col gap-3">
                <SectionHeader>Workspace</SectionHeader>
                <ToggleRow
                    label="Enabled"
                    description="Master switch for workspace features."
                    checked={workspaceEnabled}
                    disabled={disabled}
                    onCheckedChange={(next) => updateBranch(["workspace", "enabled"], next)}
                />
                <ToggleRow
                    label="Approval required"
                    description="Pause workspace actions until the user approves."
                    checked={workspace.needsApproval === true}
                    disabled={disabled || !workspaceEnabled}
                    onCheckedChange={(next) => updateBranch(["workspace", "needsApproval"], next)}
                />
            </div>

            <Separator />

            {/* Capabilities — each toggle is the enable, extra config reveals inline */}
            <div className="flex flex-col gap-4">
                <SectionHeader>Capabilities</SectionHeader>

                <div className="flex flex-col gap-3">
                    <ToggleRow
                        label="Memory"
                        description="Persist conversation memory across runs."
                        checked={workspace.memory?.enabled === true}
                        disabled={disabled}
                        onCheckedChange={(next) => updateBranch(["workspace", "memory", "enabled"], next)}
                    />
                    {workspace.memory?.enabled === true && (
                        <ExpandBlock>
                            <AutoText
                                label="Namespace"
                                value={workspace.memory?.namespace ?? ""}
                                placeholder="default"
                                disabled={disabled}
                                onCommit={(v) => updateBranch(["workspace", "memory", "namespace"], v || undefined)}
                            />
                        </ExpandBlock>
                    )}
                </div>

                <ToggleRow
                    label="Tasks"
                    description="Allow the agent to schedule and run background tasks."
                    checked={workspace.tasks?.enabled === true}
                    disabled={disabled}
                    onCheckedChange={(next) => updateBranch(["workspace", "tasks", "enabled"], next)}
                />

                {/* Storage — title and provider inline */}
                <div className="flex items-center justify-between gap-3">
                    <span className="text-xs font-medium text-foreground">Storage</span>
                    <Select
                        value={workspace.storage?.provider ?? "none"}
                        disabled={disabled}
                        onValueChange={(v) =>
                            updateBranch(["workspace", "storage"], v === "none" ? undefined : { provider: v })
                        }
                    >
                        <SelectTrigger className="h-8 w-44 cursor-pointer text-xs">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {STORAGE_PROVIDERS.map((opt) => (
                                <SelectItem key={opt.value} value={opt.value} disabled={opt.disabled}>
                                    {opt.label}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>

                <div className="flex flex-col gap-3">
                    <ToggleRow
                        label="Sandbox"
                        description="Run agent code in an isolated execution sandbox."
                        checked={!!workspace.sandbox}
                        disabled={disabled}
                        onCheckedChange={(next) =>
                            updateBranch(["workspace", "sandbox"], next ? { provider: "lambda" } : undefined)
                        }
                    />
                    {workspace.sandbox && (
                        <ExpandBlock>
                            <SandboxConfig sandbox={workspace.sandbox} disabled={disabled} updateBranch={updateBranch} />
                        </ExpandBlock>
                    )}
                </div>
            </div>
        </div>
    );
}

const STORAGE_PROVIDERS: { value: string; label: string; disabled?: boolean }[] = [
    { value: "none", label: "None" },
    { value: "s3", label: "Amazon S3" },
    { value: "r2", label: "Cloudflare R2 (coming soon)", disabled: true },
    { value: "gcs", label: "Google Cloud Storage (coming soon)", disabled: true },
];

const SANDBOX_PROVIDERS: { value: NonNullable<SandboxSlice["provider"]>; label: string }[] = [
    { value: "lambda", label: "AWS Lambda" },
    { value: "e2b", label: "e2b" },
    { value: "daytona", label: "Daytona" },
];

/** Sandbox provider picker plus shared limits and the active provider's options. */
function SandboxConfig({
    sandbox,
    disabled,
    updateBranch,
}: {
    sandbox: SandboxSlice;
    disabled: boolean;
    updateBranch: UpdateBranch;
}) {
    const provider = sandbox.provider ?? "lambda";
    const options = isRecord(sandbox.options) ? sandbox.options : {};
    const setOption = (key: string, value: unknown) => updateBranch(["workspace", "sandbox", "options", key], value);

    return (
        <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
                <label className="text-[11px] text-muted-foreground">Provider</label>
                <Select
                    value={provider}
                    disabled={disabled}
                    onValueChange={(v) =>
                        // Switching provider preserves shared limits but drops provider-specific options.
                        updateBranch(["workspace", "sandbox"], {
                            provider: v,
                            ...(sandbox.timeout !== undefined ? { timeout: sandbox.timeout } : {}),
                            ...(sandbox.memoryLimit !== undefined ? { memoryLimit: sandbox.memoryLimit } : {}),
                            ...(sandbox.outputLimitBytes !== undefined
                                ? { outputLimitBytes: sandbox.outputLimitBytes }
                                : {}),
                        })
                    }
                >
                    <SelectTrigger className="h-8 w-full cursor-pointer text-xs">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        {SANDBOX_PROVIDERS.map((opt) => (
                            <SelectItem key={opt.value} value={opt.value}>
                                {opt.label}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </div>

            <div className="grid grid-cols-3 gap-2">
                <AutoNumber
                    label="Timeout (s)"
                    value={sandbox.timeout}
                    disabled={disabled}
                    onCommit={(v) => updateBranch(["workspace", "sandbox", "timeout"], v)}
                />
                <AutoNumber
                    label="Memory (MB)"
                    value={sandbox.memoryLimit}
                    disabled={disabled}
                    onCommit={(v) => updateBranch(["workspace", "sandbox", "memoryLimit"], v)}
                />
                <AutoNumber
                    label="Output bytes"
                    value={sandbox.outputLimitBytes}
                    disabled={disabled}
                    onCommit={(v) => updateBranch(["workspace", "sandbox", "outputLimitBytes"], v)}
                />
            </div>

            <ProviderOptions provider={provider} options={options} disabled={disabled} setOption={setOption} />
        </div>
    );
}

/** Renders the input set for the selected sandbox provider. */
function ProviderOptions({
    provider,
    options,
    disabled,
    setOption,
}: {
    provider: string;
    options: Record<string, unknown>;
    disabled: boolean;
    setOption: (key: string, value: unknown) => void;
}) {
    const text = (key: string, label: string, extra?: { type?: string; placeholder?: string }) => (
        <AutoText
            label={label}
            value={asString(options[key])}
            type={extra?.type}
            placeholder={extra?.placeholder}
            disabled={disabled}
            onCommit={(v) => setOption(key, v || undefined)}
        />
    );

    if (provider === "lambda") {
        return (
            <OptionsBlock label="Lambda options">
                {text("bashFunctionName", "Bash function")}
                {text("nodeFunctionName", "Node function")}
                {text("pythonFunctionName", "Python function")}
                <div className="flex flex-col gap-1">
                    <label className="text-[11px] text-muted-foreground">Network access</label>
                    <Select
                        value={asString(options.networkAccess) || "disabled"}
                        disabled={disabled}
                        onValueChange={(v) => setOption("networkAccess", v)}
                    >
                        <SelectTrigger className="h-8 w-full cursor-pointer text-xs">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="disabled">Disabled</SelectItem>
                            <SelectItem value="public">Public</SelectItem>
                        </SelectContent>
                    </Select>
                </div>
            </OptionsBlock>
        );
    }

    if (provider === "e2b") {
        return (
            <OptionsBlock label="e2b options">
                {text("apiKey", "API key", { type: "password", placeholder: "${E2B_API_KEY}" })}
                {text("organizationId", "Organization ID")}
                {text("template", "Template")}
                {text("templateId", "Template ID")}
                {text("workspaceRoot", "Workspace root")}
            </OptionsBlock>
        );
    }

    if (provider === "daytona") {
        const envVars = isRecord(options.envVars) ? (options.envVars as Record<string, string>) : {};

        return (
            <OptionsBlock label="Daytona options">
                {text("apiKey", "API key", { type: "password", placeholder: "${DAYTONA_API_KEY}" })}
                {text("organizationId", "Organization ID")}
                {text("apiUrl", "API URL")}
                {text("target", "Target")}
                {text("snapshot", "Snapshot")}
                {text("image", "Image")}
                {text("workspaceRoot", "Workspace root")}
                {text("workspaceBucketName", "Workspace bucket")}
                {text("skillsBucketName", "Skills bucket")}
                {text("skillsMountPath", "Skills mount path")}
                {text("awsRegion", "AWS region")}
                {text("networkAllowList", "Network allow list")}
                <ToggleRow
                    label="Mount AWS S3 buckets"
                    checked={options.mountAwsS3Buckets === true}
                    disabled={disabled}
                    onCheckedChange={(v) => setOption("mountAwsS3Buckets", v || undefined)}
                />
                <ToggleRow
                    label="Block all network egress"
                    checked={options.networkBlockAll === true}
                    disabled={disabled}
                    onCheckedChange={(v) => setOption("networkBlockAll", v || undefined)}
                />
                <EnvVarsEditor
                    value={envVars}
                    disabled={disabled}
                    onCommit={(v) => setOption("envVars", Object.keys(v).length > 0 ? v : undefined)}
                />
            </OptionsBlock>
        );
    }

    return null;
}

/** Indented reveal block matching the Agent card's expand styling. */
function ExpandBlock({ children }: { children: ReactNode }) {
    return <div className="ml-1 flex flex-col gap-2.5 border-l-2 border-border pl-3">{children}</div>;
}

/** Bordered container that groups a provider's option inputs. */
function OptionsBlock({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className="flex flex-col gap-2 rounded-lg border border-border/70 bg-muted/20 p-3">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground/60">{label}</span>
            <div className="flex flex-col gap-2">{children}</div>
        </div>
    );
}

/** Label + Switch row; the switch is the feature's enable control. */
function ToggleRow({
    label,
    description,
    checked,
    onCheckedChange,
    disabled,
}: {
    label: string;
    description?: string;
    checked: boolean;
    onCheckedChange: (next: boolean) => void;
    disabled?: boolean;
}) {
    return (
        <div className="flex items-center justify-between gap-3">
            <div className="flex flex-col">
                <span className="text-xs font-medium text-foreground">{label}</span>
                {description && <span className="text-[11px] text-muted-foreground">{description}</span>}
            </div>
            <Switch checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} className="cursor-pointer" />
        </div>
    );
}

/** Text input that holds a local draft and commits on blur / Enter; never clobbers an in-flight edit. */
function AutoText({
    label,
    value,
    placeholder,
    type,
    disabled,
    onCommit,
}: {
    label: string;
    value: string;
    placeholder?: string;
    type?: string;
    disabled?: boolean;
    onCommit: (value: string) => void;
}) {
    const [draft, setDraft] = useState(value);
    const [prevValue, setPrevValue] = useState(value);
    // Resync only when the upstream value actually changes; never while typing.
    if (value !== prevValue) {
        setPrevValue(value);
        setDraft(value);
    }

    const commit = () => {
        if (draft !== value) onCommit(draft);
    };

    return (
        <div className="flex flex-col gap-1">
            <label className="text-[11px] text-muted-foreground">{label}</label>
            <Input
                type={type ?? "text"}
                value={draft}
                placeholder={placeholder}
                disabled={disabled}
                className="h-8 text-xs"
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commit}
                onKeyDown={(e) => {
                    if (e.key === "Enter") commit();
                }}
            />
        </div>
    );
}

/** Numeric input that holds a local draft and commits a parsed number on blur / Enter. */
function AutoNumber({
    label,
    value,
    disabled,
    onCommit,
}: {
    label: string;
    value: number | undefined;
    disabled?: boolean;
    onCommit: (value: number | undefined) => void;
}) {
    const text = numberToString(value);
    const [draft, setDraft] = useState(text);
    const [prevText, setPrevText] = useState(text);
    // Resync only when the upstream value actually changes; never while typing.
    if (text !== prevText) {
        setPrevText(text);
        setDraft(text);
    }

    const commit = () => {
        if (draft !== text) onCommit(parseNumber(draft));
    };

    return (
        <div className="flex flex-col gap-1">
            <label className="text-[11px] text-muted-foreground">{label}</label>
            <Input
                type="number"
                value={draft}
                disabled={disabled}
                className="h-8 text-xs"
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commit}
                onKeyDown={(e) => {
                    if (e.key === "Enter") commit();
                }}
            />
        </div>
    );
}

/** Key/value editor that holds local rows and commits the map on blur, preserving in-progress empty rows. */
function EnvVarsEditor({
    value,
    disabled,
    onCommit,
}: {
    value: Record<string, string>;
    disabled?: boolean;
    onCommit: (next: Record<string, string>) => void;
}) {
    const [rows, setRows] = useState<[string, string][]>(() => Object.entries(value));
    const valueKey = JSON.stringify(value);
    const [prevValueKey, setPrevValueKey] = useState(valueKey);
    // Resync only on an external change to `value`; ignore our own commit echo so a
    // half-typed (empty-key) row isn't wiped, and never reset while typing.
    if (valueKey !== prevValueKey) {
        setPrevValueKey(valueKey);
        if (valueKey !== JSON.stringify(toMap(rows))) {
            setRows(Object.entries(value));
        }
    }

    return (
        <div className="flex flex-col gap-1.5">
            <label className="text-[11px] text-muted-foreground">Environment variables</label>
            {rows.map(([k, v], index) => (
                <div key={index} className="flex items-center gap-1.5">
                    <Input
                        value={k}
                        placeholder="KEY"
                        disabled={disabled}
                        className="h-7 text-xs"
                        onChange={(e) => setRows((prev) => prev.map((row, i) => (i === index ? [e.target.value, row[1]] : row)))}
                        onBlur={() => onCommit(toMap(rows))}
                    />
                    <Input
                        value={v}
                        placeholder="value"
                        disabled={disabled}
                        className="h-7 text-xs"
                        onChange={(e) => setRows((prev) => prev.map((row, i) => (i === index ? [row[0], e.target.value] : row)))}
                        onBlur={() => onCommit(toMap(rows))}
                    />
                    <Button
                        size="icon-xs"
                        variant="ghost"
                        className="cursor-pointer"
                        disabled={disabled}
                        onClick={() => {
                            const next = rows.filter((_, i) => i !== index);
                            setRows(next);
                            onCommit(toMap(next));
                        }}
                    >
                        <Trash2 className="size-3.5" />
                    </Button>
                </div>
            ))}
            <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 cursor-pointer self-start text-[11px]"
                disabled={disabled}
                onClick={() => setRows((prev) => [...prev, ["", ""]])}
            >
                <Plus className="size-3.5" /> Add variable
            </Button>
        </div>
    );
}

function toMap(rows: [string, string][]): Record<string, string> {
    const map: Record<string, string> = {};
    for (const [k, v] of rows) {
        const key = k.trim();
        if (key) map[key] = v;
    }

    return map;
}

function asString(value: unknown): string {
    return typeof value === "string" ? value : "";
}

function numberToString(value: number | undefined): string {
    return typeof value === "number" ? String(value) : "";
}

function parseNumber(value: string): number | undefined {
    if (value.trim().length === 0) return undefined;
    const n = Number(value);

    return Number.isFinite(n) ? n : undefined;
}
