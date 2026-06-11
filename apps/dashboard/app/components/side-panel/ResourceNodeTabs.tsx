"use client";

/**
 * Side-panel editors for standalone workspaceConfig and sandboxConfig canvas
 * nodes. Agent config stores references to these ids; node data stores the
 * editable resource snapshot shown in the dashboard.
 */
import type { BaseNodeData } from "@/app/components/node/BaseNode";
import { BranchEditor } from "@/app/components/side-panel/BranchEditor";
import { ToggleRow } from "@/app/components/side-panel/ConfigControls";
import { SectionHeader } from "@/app/components/side-panel/SectionHeader";
import { Input } from "@/app/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/app/components/ui/select";
import { Separator } from "@/app/components/ui/separator";
import { isRecord } from "@/app/lib/utils";

type UpdateNodeData = (patch: Partial<BaseNodeData>) => void;

const WORKSPACE_DEFAULT_CONFIG = {
    storage: { provider: "s3" },
};

const SANDBOX_DEFAULT_CONFIG = {
    provider: "lambda",
    permissionMode: "ask",
};

/** Details editor for a workspaceConfig reference node. */
export function WorkspaceResourceDetailsTab({
    data,
    editName,
    setEditName,
    onSaveName,
    onUpdateNodeData,
}: {
    data: BaseNodeData;
    editName: string;
    setEditName: (name: string) => void;
    onSaveName: () => void;
    onUpdateNodeData: UpdateNodeData;
}) {
    const config: Record<string, unknown> = isRecord(data.config) ? data.config : WORKSPACE_DEFAULT_CONFIG;
    const harness = isRecord(config.harness) ? config.harness : {};

    return (
        <div className="flex flex-1 flex-col gap-5 overflow-y-auto p-4">
            <ResourceNameFields
                editName={editName}
                setEditName={setEditName}
                onSaveName={onSaveName}
                resourceId={data.resourceId ?? ""}
                resourceIdLabel="Workspace id"
                resourceIdPlaceholder="ws_default"
                onResourceIdChange={(resourceId) => onUpdateNodeData({ resourceId: resourceId })}
            />

            <Separator />

            <div className="flex flex-col gap-3">
                <SectionHeader>Agent reference</SectionHeader>
                <TextField
                    label="Mount name"
                    value={data.mountName ?? ""}
                    placeholder="default"
                    onCommit={(mountName) => onUpdateNodeData({ mountName: mountName || undefined })}
                />
                <p className="text-[11px] text-muted-foreground">
                    The graph writes this node into `config.workspaces[]` for each connected agent.
                </p>
            </div>

            <Separator />

            <div className="flex flex-col gap-3">
                <SectionHeader>Workspace config</SectionHeader>
                <div className="flex items-center justify-between gap-3">
                    <span className="text-xs font-medium text-foreground">Storage</span>
                    <Select value="s3" disabled>
                        <SelectTrigger className="h-8 w-40 cursor-not-allowed text-xs">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="s3">Amazon S3</SelectItem>
                        </SelectContent>
                    </Select>
                </div>
                <ToggleRow
                    label="Harness"
                    description="Inject workspace harness guidance."
                    checked={harness.enabled === true}
                    onCheckedChange={(enabled) =>
                        onUpdateNodeData({
                            config: {
                                ...config,
                                storage: { provider: "s3" },
                                harness: enabled ? { enabled: true } : undefined,
                            },
                        })
                    }
                />
            </div>
        </div>
    );
}

/** Details editor for a sandboxConfig reference node. */
export function SandboxResourceDetailsTab({
    data,
    editName,
    setEditName,
    onSaveName,
    onUpdateNodeData,
}: {
    data: BaseNodeData;
    editName: string;
    setEditName: (name: string) => void;
    onSaveName: () => void;
    onUpdateNodeData: UpdateNodeData;
}) {
    const config: Record<string, unknown> = isRecord(data.config) ? data.config : SANDBOX_DEFAULT_CONFIG;

    function setConfig(patch: Record<string, unknown>) {
        onUpdateNodeData({ config: { ...config, ...patch } });
    }

    return (
        <div className="flex flex-1 flex-col gap-5 overflow-y-auto p-4">
            <ResourceNameFields
                editName={editName}
                setEditName={setEditName}
                onSaveName={onSaveName}
                resourceId={data.resourceId ?? ""}
                resourceIdLabel="Sandbox id"
                resourceIdPlaceholder="sb_default"
                onResourceIdChange={(resourceId) => onUpdateNodeData({ resourceId: resourceId })}
            />

            <Separator />

            <div className="flex flex-col gap-3">
                <SectionHeader>Sandbox config</SectionHeader>
                <SelectField
                    label="Provider"
                    value={typeof config.provider === "string" ? config.provider : "lambda"}
                    onValueChange={(provider) => setConfig({ provider: provider })}
                    options={[
                        { value: "lambda", label: "AWS Lambda" },
                        { value: "e2b", label: "e2b" },
                        { value: "daytona", label: "Daytona" },
                        { value: "kubernetes", label: "Kubernetes" },
                    ]}
                />
                <SelectField
                    label="Permission mode"
                    value={typeof config.permissionMode === "string" ? config.permissionMode : "ask"}
                    onValueChange={(permissionMode) => setConfig({ permissionMode: permissionMode })}
                    options={[
                        { value: "edit", label: "Edit" },
                        { value: "ask", label: "Ask" },
                        { value: "bypass", label: "Bypass" },
                    ]}
                />
                <ToggleRow
                    label="Internet"
                    description="Allow public network access from the sandbox."
                    checked={config.internet === true}
                    onCheckedChange={(internet) => setConfig({ internet: internet ? true : undefined })}
                />
                <ToggleRow
                    label="Persistent"
                    description="Reserve a long-lived sandbox per workspace namespace."
                    checked={config.persistent === true}
                    disabled={config.provider === "lambda"}
                    onCheckedChange={(persistent) => setConfig({ persistent: persistent ? true : undefined })}
                />
            </div>
        </div>
    );
}

/** Raw JSON editor for resource node config snapshots. */
export function ResourceConfigTab({
    nodeType,
    data,
    onUpdateNodeData,
}: {
    nodeType: "workspace" | "sandbox";
    data: BaseNodeData;
    onUpdateNodeData: UpdateNodeData;
}) {
    const fallback = nodeType === "workspace" ? WORKSPACE_DEFAULT_CONFIG : SANDBOX_DEFAULT_CONFIG;

    return (
        <div className="flex flex-1 flex-col gap-5 overflow-y-auto p-4">
            <BranchEditor
                title={nodeType === "workspace" ? "Workspace Config" : "Sandbox Config"}
                value={data.config ?? fallback}
                onSave={(config) => onUpdateNodeData({ config: isRecord(config) ? config : fallback })}
            />
        </div>
    );
}

function ResourceNameFields({
    editName,
    setEditName,
    onSaveName,
    resourceId,
    resourceIdLabel,
    resourceIdPlaceholder,
    onResourceIdChange,
}: {
    editName: string;
    setEditName: (name: string) => void;
    onSaveName: () => void;
    resourceId: string;
    resourceIdLabel: string;
    resourceIdPlaceholder: string;
    onResourceIdChange: (resourceId: string | undefined) => void;
}) {
    return (
        <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
                <SectionHeader>Name</SectionHeader>
                <Input
                    value={editName}
                    onChange={(event) => setEditName(event.target.value)}
                    className="h-8 text-sm"
                    onBlur={onSaveName}
                    onKeyDown={(event) => {
                        if (event.key === "Enter") onSaveName();
                    }}
                />
            </div>
            <TextField
                label={resourceIdLabel}
                value={resourceId}
                placeholder={resourceIdPlaceholder}
                onCommit={(value) => onResourceIdChange(value || undefined)}
            />
        </div>
    );
}

function TextField({
    label,
    value,
    placeholder,
    onCommit,
}: {
    label: string;
    value: string;
    placeholder?: string;
    onCommit: (value: string) => void;
}) {
    return (
        <div className="flex flex-col gap-1">
            <label className="text-[11px] text-muted-foreground">{label}</label>
            <Input
                defaultValue={value}
                placeholder={placeholder}
                className="h-8 font-mono text-xs"
                onBlur={(event) => onCommit(event.currentTarget.value.trim())}
                onKeyDown={(event) => {
                    if (event.key === "Enter") {
                        onCommit(event.currentTarget.value.trim());
                        event.currentTarget.blur();
                    }
                }}
            />
        </div>
    );
}

function SelectField({
    label,
    value,
    onValueChange,
    options,
}: {
    label: string;
    value: string;
    onValueChange: (value: string) => void;
    options: Array<{ value: string; label: string }>;
}) {
    return (
        <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-medium text-foreground">{label}</span>
            <Select value={value} onValueChange={onValueChange}>
                <SelectTrigger className="h-8 w-40 cursor-pointer text-xs">
                    <SelectValue />
                </SelectTrigger>
                <SelectContent>
                    {options.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                            {option.label}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
        </div>
    );
}
