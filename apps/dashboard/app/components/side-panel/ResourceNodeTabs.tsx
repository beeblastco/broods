"use client";

/**
 * Side-panel editors for standalone workspaceConfig and sandboxConfig canvas
 * nodes. Agent config stores references to these ids; node data stores the
 * editable resource snapshot shown in the dashboard.
 */
import type { BaseNodeData } from "@/app/components/node/BaseNode";
import { BranchEditor } from "@/app/components/side-panel/BranchEditor";
import {
  ExpandBlock,
  ToggleRow,
} from "@/app/components/side-panel/ConfigControls";
import { SectionHeader } from "@/app/components/side-panel/SectionHeader";
import { Input } from "@/app/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/app/components/ui/select";
import { Separator } from "@/app/components/ui/separator";
import { isPlainObject } from "@/app/lib/utils";

type UpdateNodeData = (patch: Partial<BaseNodeData>) => void;

const WORKSPACE_DEFAULT_CONFIG = {
  storage: { provider: "s3" },
};

const SANDBOX_DEFAULT_CONFIG = {
  provider: "sandbox",
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
  const config: Record<string, unknown> = isPlainObject(data.config)
    ? data.config
    : WORKSPACE_DEFAULT_CONFIG;
  const harness = isPlainObject(config.harness) ? config.harness : {};
  const storage: Record<string, unknown> = isPlainObject(config.storage)
    ? config.storage
    : { provider: "s3" };
  const auth = isPlainObject(storage.auth) ? storage.auth : {};
  const ownBucket =
    auth.type === "assumeRole" || typeof storage.bucket === "string";
  const harnessFeatureEnabled = (key: "workspace" | "memory") => {
    const feature = isPlainObject(harness[key])
      ? (harness[key] as Record<string, unknown>)
      : {};

    return feature.enabled !== false;
  };

  function setConfig(patch: Record<string, unknown>) {
    onUpdateNodeData({ config: { ...config, ...patch } });
  }

  // Storage merges rather than replaces: a bring-your-own bucket lives here, and
  // rewriting it as { provider: "s3" } on every unrelated edit silently dropped it.
  function setStorage(patch: Record<string, unknown>) {
    setConfig({ storage: { ...storage, provider: "s3", ...patch } });
  }

  // Features default to on: an enabled feature is stored as an omitted key, a
  // disabled one as { enabled: false }; an empty harness object is dropped.
  function setHarnessFeature(key: "workspace" | "memory", enabled: boolean) {
    const next: Record<string, unknown> = { ...harness };
    if (enabled) {
      delete next[key];
    } else {
      next[key] = { enabled: false };
    }
    setConfig({ harness: Object.keys(next).length > 0 ? next : undefined });
  }

  return (
    <div className="flex flex-1 flex-col gap-5 overflow-y-auto p-4">
      <ResourceNameFields
        editName={editName}
        setEditName={setEditName}
        onSaveName={onSaveName}
        resourceId={data.resourceId ?? ""}
        resourceIdLabel="Workspace id"
        resourceIdPlaceholder="ws_default"
        onResourceIdChange={(resourceId) =>
          onUpdateNodeData({ resourceId: resourceId })
        }
      />

      <Separator />

      <div className="flex flex-col gap-3">
        <SectionHeader>Agent reference</SectionHeader>
        <TextField
          label="Mount name"
          value={data.mountName ?? ""}
          placeholder="default"
          onCommit={(mountName) =>
            onUpdateNodeData({ mountName: mountName || undefined })
          }
        />
        <p className="text-[11px] text-muted-foreground">
          The graph writes this node into `config.workspaces[]` for each
          connected agent.
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
          label="Bring your own bucket"
          description="Mount your S3 bucket instead of the managed one."
          checked={ownBucket}
          onCheckedChange={(own) =>
            setConfig({
              storage: own
                ? { ...storage, provider: "s3" }
                : { provider: "s3" },
            })
          }
        />
        {ownBucket && (
          <ExpandBlock>
            <TextField
              label="Bucket"
              value={typeof storage.bucket === "string" ? storage.bucket : ""}
              placeholder="my-workspace-bucket"
              onCommit={(bucket) => setStorage({ bucket: bucket || undefined })}
            />
            <TextField
              label="Region"
              value={typeof storage.region === "string" ? storage.region : ""}
              placeholder="eu-west-1"
              onCommit={(region) => setStorage({ region: region || undefined })}
            />
            <TextField
              label="Endpoint"
              value={
                typeof storage.endpoint === "string" ? storage.endpoint : ""
              }
              placeholder="https://…  (R2, MinIO — omit for AWS)"
              onCommit={(endpoint) =>
                setStorage({ endpoint: endpoint || undefined })
              }
            />
            <TextField
              label="Prefix"
              value={typeof storage.prefix === "string" ? storage.prefix : ""}
              placeholder="teams/support"
              onCommit={(prefix) => setStorage({ prefix: prefix || undefined })}
            />
            <SelectField
              label="Auth"
              value={auth.type === "assumeRole" ? "assumeRole" : "managed"}
              onValueChange={(type) =>
                setStorage({
                  auth:
                    type === "assumeRole"
                      ? {
                          ...auth,
                          type: "assumeRole",
                          roleArn: auth.roleArn ?? "",
                        }
                      : { type: "managed" },
                })
              }
              options={[
                { value: "managed", label: "Managed" },
                { value: "assumeRole", label: "Assume role" },
              ]}
            />
            {auth.type === "assumeRole" && (
              <ExpandBlock>
                <TextField
                  label="Role ARN"
                  value={typeof auth.roleArn === "string" ? auth.roleArn : ""}
                  placeholder="arn:aws:iam::123456789012:role/BroodsWorkspace"
                  onCommit={(roleArn) =>
                    setStorage({
                      auth: { ...auth, type: "assumeRole", roleArn: roleArn },
                    })
                  }
                />
                <TextField
                  label="External id"
                  value={
                    typeof auth.externalId === "string" ? auth.externalId : ""
                  }
                  placeholder="optional, pair with your role's trust policy"
                  onCommit={(externalId) =>
                    setStorage({
                      auth: {
                        ...auth,
                        type: "assumeRole",
                        externalId: externalId || undefined,
                      },
                    })
                  }
                />
              </ExpandBlock>
            )}
          </ExpandBlock>
        )}
        <ToggleRow
          label="Isolation"
          description="Split the filesystem per conversation instead of sharing one root."
          checked={config.isolation === true}
          onCheckedChange={(isolation) =>
            setConfig({ isolation: isolation ? true : undefined })
          }
        />
        {config.isolation === true && (
          <ExpandBlock>
            <p className="text-[11px] text-muted-foreground">
              Every channel attached to this workspace must set
              `workspaceScope`. A `conversation` scope mounts a private child
              folder per thread, issue, or PR; a `channel` scope mounts the
              workspace root.
            </p>
          </ExpandBlock>
        )}
        <ToggleRow
          label="Guidance"
          description="Inject the workspace guidance prompt."
          checked={harnessFeatureEnabled("workspace")}
          onCheckedChange={(enabled) => setHarnessFeature("workspace", enabled)}
        />
        <ToggleRow
          label="Memory"
          description="Structured memory: memory_save tool and memory/MEMORY.md index."
          checked={harnessFeatureEnabled("memory")}
          onCheckedChange={(enabled) => setHarnessFeature("memory", enabled)}
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
  const config: Record<string, unknown> = isPlainObject(data.config)
    ? data.config
    : SANDBOX_DEFAULT_CONFIG;
  // Egress policy. Core models this as `network.mode` (allow-all/deny-all/restricted),
  // which is what code-synced sandboxes carry — not a flat `internet` boolean.
  const network: { mode?: string } = isPlainObject(config.network)
    ? (config.network as { mode?: string })
    : {};

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
        onResourceIdChange={(resourceId) =>
          onUpdateNodeData({ resourceId: resourceId })
        }
      />

      <Separator />

      <div className="flex flex-col gap-3">
        <SectionHeader>Sandbox config</SectionHeader>
        <SelectField
          label="Provider"
          value={
            typeof config.provider === "string" ? config.provider : "sandbox"
          }
          onValueChange={(provider) => setConfig({ provider: provider })}
          options={[
            { value: "sandbox", label: "Sandbox" },
            { value: "lambda", label: "AWS Lambda" },
            { value: "e2b", label: "e2b" },
            { value: "daytona", label: "Daytona" },
          ]}
        />
        <SelectField
          label="Permission mode"
          value={
            typeof config.permissionMode === "string"
              ? config.permissionMode
              : "ask"
          }
          onValueChange={(permissionMode) =>
            setConfig({ permissionMode: permissionMode })
          }
          options={[
            { value: "edit", label: "Edit" },
            { value: "ask", label: "Ask" },
            { value: "bypass", label: "Bypass" },
          ]}
        />
        <ToggleRow
          label="Internet"
          description="Allow public network access from the sandbox."
          checked={
            network.mode === "allow-all" || network.mode === "restricted"
          }
          onCheckedChange={(internet) =>
            setConfig({
              network: {
                ...network,
                // Preserve an existing `restricted` policy when toggling on;
                // otherwise map the binary switch onto core's egress modes.
                mode: internet
                  ? network.mode === "restricted"
                    ? "restricted"
                    : "allow-all"
                  : "deny-all",
              },
            })
          }
        />
        <ToggleRow
          label="Persistent"
          description="Reserve a long-lived sandbox per workspace namespace."
          checked={config.persistent === true}
          onCheckedChange={(persistent) =>
            setConfig({ persistent: persistent ? true : undefined })
          }
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
  const fallback =
    nodeType === "workspace"
      ? WORKSPACE_DEFAULT_CONFIG
      : SANDBOX_DEFAULT_CONFIG;

  return (
    <div className="flex flex-1 flex-col gap-5 overflow-y-auto p-4">
      <BranchEditor
        title={nodeType === "workspace" ? "Workspace Config" : "Sandbox Config"}
        value={data.config ?? fallback}
        onSave={(config) =>
          onUpdateNodeData({
            config: isPlainObject(config) ? config : fallback,
          })
        }
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
