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
import { useState } from "react";

type UpdateNodeData = (patch: Partial<BaseNodeData>) => void;

const WORKSPACE_DEFAULT_CONFIG = {
  storage: { provider: "s3" },
};

const SANDBOX_DEFAULT_CONFIG = {
  provider: "sandbox",
  permissionMode: "ask",
};

// Every field that only means anything on a bring-your-own bucket. The toggle is
// derived from all of them, not just `bucket`: a workspace carrying only a prefix
// would otherwise show the switch off and hide the value it already has.
const OWN_BUCKET_FIELDS = ["bucket", "region", "endpoint", "prefix"] as const;

// What the default harness gives every workspace. Always on; turning one off is a
// deliberate code-only choice, so these are reported here and never edited here.
const HARNESS_FEATURES = [
  { key: "workspace", label: "Guidance" },
  { key: "memory", label: "Memory" },
] as const;

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
}): React.JSX.Element {
  const config: Record<string, unknown> = isPlainObject(data.config)
    ? data.config
    : WORKSPACE_DEFAULT_CONFIG;
  const harness = isPlainObject(config.harness) ? config.harness : {};
  const storage: Record<string, unknown> = isPlainObject(config.storage)
    ? config.storage
    : { provider: "s3" };
  const auth = isPlainObject(storage.auth) ? storage.auth : {};
  // Local toggle: switching it on reveals empty fields and persists nothing until a
  // bucket is typed, so a purely derived switch would snap straight back off and the
  // fields could never be reached. Resync when the saved config changes elsewhere.
  const savedOwnBucket =
    auth.type === "assumeRole" ||
    OWN_BUCKET_FIELDS.some((field) => typeof storage[field] === "string");
  const [ownBucket, setOwnBucket] = useState(savedOwnBucket);
  const [lastSavedOwnBucket, setLastSavedOwnBucket] = useState(savedOwnBucket);
  if (savedOwnBucket !== lastSavedOwnBucket) {
    setLastSavedOwnBucket(savedOwnBucket);
    setOwnBucket(savedOwnBucket);
  }
  // Guidance and memory are part of what the default harness IS, so they are on and
  // stay on — there is no switch here. The opt-out is a code-only escape hatch; the
  // dashboard only reports it, so an agent configured in code never looks untouched.
  const disabledFeatures = HARNESS_FEATURES.filter((feature) => {
    const value = isPlainObject(harness[feature.key])
      ? (harness[feature.key] as Record<string, unknown>)
      : {};

    return value.enabled === false;
  });

  function setConfig(patch: Record<string, unknown>) {
    onUpdateNodeData({ config: mergeDropping(config, patch) });
  }

  // Storage merges rather than replaces: a bring-your-own bucket lives here, and
  // rewriting it as { provider: "s3" } on every unrelated edit silently dropped it.
  function setStorage(patch: Record<string, unknown>) {
    setConfig({
      storage: mergeDropping({ ...storage, provider: "s3" }, patch),
    });
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
          <Select items={{ s3: "S3-compatible" }} value="s3" disabled>
            <SelectTrigger className="h-8 w-40 cursor-not-allowed text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="s3">S3-compatible</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <ToggleRow
          label="Bring your own bucket"
          description="Mount your S3 bucket instead of the managed one."
          checked={ownBucket}
          onCheckedChange={(own) => {
            setOwnBucket(own);
            // Only switching off writes: it clears the bucket back to managed.
            // Switching on just reveals the fields — each one saves as it is typed.
            if (!own) {
              setConfig({ storage: { provider: "s3" } });
            }
          }}
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
              placeholder="https://…  (R2, MinIO; omit for AWS)"
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
              Every channel attached to this workspace must set `partition`. A
              `conversation` scope mounts a private child folder per thread,
              issue, or PR; a `shared` scope mounts the workspace root.
            </p>
          </ExpandBlock>
        )}
        {disabledFeatures.length > 0 && (
          <p className="text-[11px] text-muted-foreground">
            {disabledFeatures.map((feature) => feature.label).join(" and ")}{" "}
            {disabledFeatures.length > 1 ? "are" : "is"} switched off in code
            for this workspace. {disabledFeatures.length > 1 ? "Both" : "It"}{" "}
            {disabledFeatures.length > 1 ? "are" : "is"} on by default and can
            only be changed through the CLI or SDK.
          </p>
        )}
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
  managedByCode = false,
}: {
  data: BaseNodeData;
  editName: string;
  setEditName: (name: string) => void;
  onSaveName: () => void;
  onUpdateNodeData: UpdateNodeData;
  /** Code owns this row, so the canvas save discards config edits: show them read-only. */
  managedByCode?: boolean;
}): React.JSX.Element {
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
        {managedByCode && (
          <p className="text-[11px] text-muted-foreground">
            Defined in code. Edit the sandbox in your broods project and deploy.
          </p>
        )}
        <SelectField
          label="Provider"
          disabled={managedByCode}
          value={
            typeof config.provider === "string" ? config.provider : "sandbox"
          }
          onValueChange={(provider) => setConfig({ provider: provider })}
          options={[
            { value: "sandbox", label: "Sandbox" },
            { value: "lambda", label: "Managed VM" },
            { value: "e2b", label: "e2b" },
            { value: "daytona", label: "Daytona" },
          ]}
        />
        <SelectField
          label="Permission mode"
          disabled={managedByCode}
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
          disabled={managedByCode}
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
          disabled={managedByCode}
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
}): React.JSX.Element {
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

// Merge a patch, treating undefined as "remove this key". These objects are
// persisted, so an `undefined` value would otherwise ride along as a real key.
function mergeDropping(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      delete next[key];
    } else {
      next[key] = value;
    }
  }

  return next;
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
  disabled,
}: {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs font-medium text-foreground">{label}</span>
      <Select
        items={options}
        value={value}
        disabled={disabled}
        onValueChange={(next) => {
          if (next !== null) {
            onValueChange(next);
          }
        }}
      >
        <SelectTrigger
          className={`h-8 w-40 text-xs ${disabled ? "cursor-not-allowed" : "cursor-pointer"}`}
        >
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
