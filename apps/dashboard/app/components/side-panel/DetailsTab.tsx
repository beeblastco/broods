"use client";

/** Details tab showing editable agent name, deployment credentials, and built-in tool config. */
import { ChannelsSection } from "@/app/components/side-panel/ChannelsSection";
import {
  ExpandBlock,
  ToggleRow,
} from "@/app/components/side-panel/ConfigControls";
import { Button } from "@/app/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/app/components/ui/dialog";
import { Input } from "@/app/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/app/components/ui/select";
import { Separator } from "@/app/components/ui/separator";
import { Switch } from "@/app/components/ui/switch";
import { Textarea } from "@/app/components/ui/textarea";
import {
  ACCOUNT_MODEL_PROVIDER_NAMES,
  MODEL_PROVIDERS,
  type AccountModelProviderName,
} from "@broods/convex/model/modelProviders";
import {
  readAgentBranch,
  readAgentPolicies,
  readModelReasoning,
  type FlatAgentConfig,
} from "@/app/lib/agentConfigCodec";
import { resolveCoreEndpoint } from "@/app/lib/coreEndpoint";
import { toErrorMessage } from "@/app/lib/errors";
import { isPlainObject } from "@/app/lib/utils";
import { api } from "@broods/convex/_generated/api";
import type { Doc, Id } from "@broods/convex/_generated/dataModel";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import {
  Check,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  RefreshCw,
  Wifi,
} from "lucide-react";
import { useRef, useState } from "react";

/**
 * Public (hash-free) view of a stage's runtime deployment, as returned by
 * `agentDeployments.getForStage`. The key is stage-wide; the agent is
 * selected per request by its Agent ID.
 */
export type StageDeployment = {
  _id: Id<"agentDeployments">;
  endpointId: string;
  projectSlug: string;
  stageSlug: string;
  keyHint?: string;
  updatedAt: number;
};

type OutputFormatConfig = {
  type?: string;
  schema?: unknown;
  name?: string;
  description?: string;
};

export type AgentProvider = AccountModelProviderName;
type AgentProviderConfig = Partial<Record<AgentProvider, { apiKey?: string }>>;
type RuntimeVariable = { key: string; value: string };
type EnvironmentVariable = FunctionReturnType<
  typeof api.environmentVariables.list
>[number];

const providerOptions: Array<{ value: AgentProvider; label: string }> =
  ACCOUNT_MODEL_PROVIDER_NAMES.map((name) => ({
    value: name,
    label: MODEL_PROVIDERS[name].label,
  }));

const REASONING_EFFORT_LABELS: Record<string, string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

const DEFAULT_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: true,
  properties: {
    answer: { type: "string" },
  },
  required: ["answer"],
};

export function DetailsTab({
  agentConfig,
  projectId,
  stageId,
  activeDeployment,
  deploymentApiKey,
  editName,
  setEditName,
  onSaveName,
  onUpdateOutputFormat,
  onGenerateKey,
  onRotateKey,
  isSavingKey,
  selectedProvider,
  runtimeVariables: _runtimeVariables,
  onSaveModelSettings,
  onUpdateToolConfig,
  onUpdateChannelConfig,
  onUpdateModelReasoning,
  onUpdatePublicAccess,
  onUpdatePolicyConfig,
}: {
  agentConfig: Doc<"agentConfigs"> | null | undefined;
  projectId: Id<"projects"> | undefined;
  stageId: Id<"stages"> | null | undefined;
  activeDeployment: StageDeployment | undefined;
  deploymentApiKey?: string;
  editName: string;
  setEditName: (name: string) => void;
  onSaveName: () => void;
  onUpdateOutputFormat?: (outputFormat: Record<string, unknown> | null) => void;
  onGenerateKey?: () => Promise<boolean>;
  onRotateKey?: () => Promise<boolean>;
  isSavingKey?: boolean;
  selectedProvider: AgentProvider;
  runtimeVariables: RuntimeVariable[];
  onSaveModelSettings?: (next: {
    provider: AgentProvider;
    modelId: string;
    customBaseUrl?: string;
    providerApiKeyName?: string | null;
  }) => Promise<void>;
  onUpdateToolConfig?: (
    toolName: string,
    config: Record<string, unknown> | null,
  ) => Promise<void>;
  onUpdateChannelConfig?: (
    kind: string,
    config: Record<string, unknown> | null,
  ) => Promise<void>;
  onUpdateModelReasoning?: (next: {
    budgetTokens?: number;
    effort?: string;
  }) => Promise<void>;
  onUpdatePublicAccess?: (enabled: boolean) => Promise<void>;
  onUpdatePolicyConfig?: (policies: string[] | null) => Promise<void>;
}): React.JSX.Element {
  const [showApiKey, setShowApiKey] = useState(false);
  const [rotateOpen, setRotateOpen] = useState(false);
  const [rotateError, setRotateError] = useState<string | null>(null);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  // Reveal a freshly generated/rotated key the moment it arrives (render-time
  // sync, not an effect); hide again once the plaintext is cleared.
  const [syncedApiKey, setSyncedApiKey] = useState(deploymentApiKey);
  if (deploymentApiKey !== syncedApiKey) {
    setSyncedApiKey(deploymentApiKey);
    setShowApiKey(Boolean(deploymentApiKey));
  }
  const [outputSchemaText, setOutputSchemaText] = useState("");
  const [hasEditedOutputSchema, setHasEditedOutputSchema] = useState(false);
  const [outputSchemaError, setOutputSchemaError] = useState<string | null>(
    null,
  );
  const [editProvider, setEditProvider] =
    useState<AgentProvider>(selectedProvider);
  const [editModelId, setEditModelId] = useState(agentConfig?.modelId ?? "");
  const [editCustomBaseUrl, setEditCustomBaseUrl] = useState(
    readCustomBaseUrl(agentConfig),
  );
  const [editProviderApiKeyName, setEditProviderApiKeyName] = useState(
    readProviderApiKeyName(agentConfig, selectedProvider),
  );
  const [newProviderApiKeyValue, setNewProviderApiKeyValue] = useState("");
  const [isSavingProviderApiKey, setIsSavingProviderApiKey] = useState(false);
  const [providerApiKeyError, setProviderApiKeyError] = useState<string | null>(
    null,
  );
  const schemaFileInputRef = useRef<HTMLInputElement | null>(null);

  // Built-in tool configs derived from agentConfig (reads extraConfig.tools, falls back to flat columns)
  const allTools = agentConfig
    ? (readAgentBranch(
        agentConfig as unknown as FlatAgentConfig,
        "tools",
      ) as Record<string, unknown>)
    : {};
  const googleSearchCfg = isPlainObject(allTools.googleSearch)
    ? (allTools.googleSearch as Record<string, unknown>)
    : { enabled: agentConfig?.searchToolEnabled };
  const googleSearchEnabled = googleSearchCfg.enabled === true;

  // Reasoning lives under model.providerOptions.<provider>.* (Vercel AI SDK shape).
  const modelBranch = agentConfig
    ? (readAgentBranch(
        agentConfig as unknown as FlatAgentConfig,
        "model",
      ) as Record<string, unknown>)
    : {};
  const { budgetTokens: reasoningBudget, effort: reasoningEffortValue } =
    readModelReasoning(modelBranch);
  const reasoningEffort = reasoningEffortValue ?? "";
  const reasoningEnabled =
    reasoningBudget !== undefined || reasoningEffort !== "";
  const [reasoningBudgetText, setReasoningBudgetText] = useState(() =>
    reasoningBudget !== undefined ? String(reasoningBudget) : "",
  );

  const coreEndpoint = resolveCoreEndpoint();
  const stagePrefix = activeDeployment?.stageSlug
    ? `/${activeDeployment.stageSlug}`
    : "";
  const projectPrefix = activeDeployment?.projectSlug
    ? `/${activeDeployment.projectSlug}`
    : "";
  const endpointUrl =
    activeDeployment && coreEndpoint.ok
      ? `${coreEndpoint.httpBaseUrl}/v1${projectPrefix}/agents${stagePrefix}/${activeDeployment.endpointId}`
      : "";
  const websocketUrl =
    activeDeployment && coreEndpoint.ok
      ? `${coreEndpoint.websocketBaseUrl}/v1${projectPrefix}/agents${stagePrefix}/${activeDeployment.endpointId}/ws`
      : "";

  // Per-agent public-endpoint opt-in (issue #65). Stored as a top-level scalar
  // in extraConfig; off by default so the agent is secured until enabled.
  const publicAccess =
    (agentConfig?.extraConfig as Record<string, unknown> | undefined)
      ?.publicAccess === true;
  const policyOptions = useQuery(
    api.agentPolicies.listForStage,
    projectId && stageId ? { projectId: projectId, stageId: stageId } : "skip",
  ) as Doc<"agentPolicies">[] | undefined;
  const environmentVariables = useQuery(
    api.environmentVariables.list,
    projectId && stageId ? { projectId: projectId, stageId: stageId } : "skip",
  ) as EnvironmentVariable[] | undefined;
  const setEnvironmentVariable = useMutation(api.environmentVariables.set);
  // Attachment is only the list. Whether a policy blocks or just records is
  // carried by the policy document, and edited with it.
  const assignedPolicyIds = readAgentPolicies(
    agentConfig as unknown as FlatAgentConfig,
  );

  const outputFormat =
    agentConfig?.outputFormat && isPlainObject(agentConfig.outputFormat)
      ? (agentConfig.outputFormat as OutputFormatConfig)
      : undefined;
  const outputFormatEnabled = outputFormat !== undefined;
  const schemaFromConfigText = isPlainObject(outputFormat?.schema)
    ? JSON.stringify(outputFormat.schema, null, 2)
    : "";
  const displayOutputSchemaText = hasEditedOutputSchema
    ? outputSchemaText
    : schemaFromConfigText;
  const providerLabel = MODEL_PROVIDERS[editProvider].label;
  const trimmedApiKeyName = editProviderApiKeyName.trim();
  const selectedApiKeyVariable = environmentVariables?.find(
    (entry) => entry.name === trimmedApiKeyName,
  );
  const apiKeyStatus =
    trimmedApiKeyName.length === 0
      ? "missing"
      : environmentVariables === undefined
        ? "loading"
        : selectedApiKeyVariable === undefined
          ? "not-found"
          : selectedApiKeyVariable.hasValue
            ? "ready"
            : "empty";

  function buildOutputFormatPayload(
    schema: Record<string, unknown>,
  ): Record<string, unknown> {
    const next: Record<string, unknown> = {
      type: "object",
      schema: schema,
    };

    if (
      typeof outputFormat?.name === "string" &&
      outputFormat.name.trim().length > 0
    ) {
      next.name = outputFormat.name.trim();
    }
    if (
      typeof outputFormat?.description === "string" &&
      outputFormat.description.trim().length > 0
    ) {
      next.description = outputFormat.description.trim();
    }

    return next;
  }

  function parseSchemaText(input: string): Record<string, unknown> | null {
    try {
      const parsed = JSON.parse(input);
      if (!isPlainObject(parsed)) {
        setOutputSchemaError("Schema must be a JSON object.");

        return null;
      }
      setOutputSchemaError(null);

      return parsed;
    } catch {
      setOutputSchemaError("Invalid schema JSON.");

      return null;
    }
  }

  function handleToggleOutputFormat(enabled: boolean) {
    if (!enabled) {
      setOutputSchemaError(null);
      setHasEditedOutputSchema(false);
      setOutputSchemaText("");
      onUpdateOutputFormat?.(null);

      return;
    }

    const existingSchema = isPlainObject(outputFormat?.schema)
      ? (outputFormat.schema as Record<string, unknown>)
      : undefined;
    setOutputSchemaError(null);

    if (existingSchema) {
      setHasEditedOutputSchema(true);
      setOutputSchemaText(JSON.stringify(existingSchema, null, 2));
      onUpdateOutputFormat?.(buildOutputFormatPayload(existingSchema));
    } else {
      setHasEditedOutputSchema(true);
      setOutputSchemaText(JSON.stringify(DEFAULT_OUTPUT_SCHEMA, null, 2));
      onUpdateOutputFormat?.(buildOutputFormatPayload(DEFAULT_OUTPUT_SCHEMA));
    }
  }

  function handleApplySchema() {
    const parsed = parseSchemaText(displayOutputSchemaText);
    if (!parsed) {
      return;
    }
    setHasEditedOutputSchema(true);
    setOutputSchemaText(JSON.stringify(parsed, null, 2));
    onUpdateOutputFormat?.(buildOutputFormatPayload(parsed));
  }

  function handleImportSchemaFile(file: File | undefined) {
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      const content = typeof reader.result === "string" ? reader.result : "";
      const parsed = parseSchemaText(content);
      if (!parsed) {
        return;
      }
      setHasEditedOutputSchema(true);
      setOutputSchemaText(JSON.stringify(parsed, null, 2));
      onUpdateOutputFormat?.(buildOutputFormatPayload(parsed));
    };
    reader.onerror = () => {
      setOutputSchemaError("Failed to read schema file.");
    };
    reader.readAsText(file);
  }

  function handleCopy(value: string, field: string) {
    navigator.clipboard.writeText(value);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 2000);
  }

  /** Auto-saves provider/model/base-URL settings; no-ops when required values are empty. */
  function saveModel(
    provider: AgentProvider,
    modelId: string,
    customBaseUrl = editCustomBaseUrl,
    providerApiKeyName: string | null = editProviderApiKeyName,
  ) {
    const trimmed = modelId.trim();
    if (!trimmed) {
      return;
    }
    const trimmedBaseUrl = customBaseUrl.trim();
    if (provider === "custom" && !trimmedBaseUrl) {
      return;
    }

    const trimmedProviderApiKeyName = providerApiKeyName?.trim() ?? "";
    void onSaveModelSettings?.({
      provider: provider,
      modelId: trimmed,
      ...(provider === "custom" ? { customBaseUrl: trimmedBaseUrl } : {}),
      providerApiKeyName:
        trimmedProviderApiKeyName.length > 0 ? trimmedProviderApiKeyName : null,
    });
  }

  async function saveInlineProviderApiKey() {
    const name = editProviderApiKeyName.trim();
    if (!name || !projectId || !stageId || isSavingProviderApiKey) return;

    setIsSavingProviderApiKey(true);
    setProviderApiKeyError(null);
    try {
      await setEnvironmentVariable({
        projectId: projectId,
        stageId: stageId,
        name: name,
        value: newProviderApiKeyValue,
      });
      setNewProviderApiKeyValue("");
      saveModel(editProvider, editModelId, editCustomBaseUrl, name);
    } catch (err) {
      setProviderApiKeyError(toErrorMessage(err));
    } finally {
      setIsSavingProviderApiKey(false);
    }
  }

  function togglePolicyId(policyId: string) {
    const nextIds = assignedPolicyIds.includes(policyId)
      ? assignedPolicyIds.filter((entry) => entry !== policyId)
      : [...assignedPolicyIds, policyId];

    // Nothing attached means nothing to evaluate: clear the field.
    void onUpdatePolicyConfig?.(nextIds.length === 0 ? null : nextIds);
  }

  return (
    <div className="flex flex-1 flex-col gap-5 p-4">
      {/* Editable name — auto-saves on blur / Enter */}
      <div className="flex flex-col gap-1.5">
        <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
          Name
        </span>
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

      {/* Agent info */}
      {agentConfig && (
        <>
          {agentConfig.description && (
            <div className="flex flex-col gap-1.5">
              <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
                Description
              </span>
              <p className="text-xs text-foreground">
                {agentConfig.description}
              </p>
            </div>
          )}
          <div className="flex flex-col gap-2">
            <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
              Provider & Model
            </span>
            <Select
              items={providerOptions}
              value={editProvider}
              onValueChange={(value) => {
                if (value === null) return;
                const nextProvider = value as AgentProvider;
                const nextApiKeyName = readProviderApiKeyName(
                  agentConfig,
                  nextProvider,
                );
                setEditProvider(nextProvider);
                setEditProviderApiKeyName(nextApiKeyName);
                setProviderApiKeyError(null);
                saveModel(
                  nextProvider,
                  editModelId,
                  editCustomBaseUrl,
                  nextApiKeyName,
                );
              }}
            >
              <SelectTrigger className="h-8 w-full cursor-pointer text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {providerOptions.map((providerOption) => (
                  <SelectItem
                    key={providerOption.value}
                    value={providerOption.value}
                  >
                    {providerOption.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              value={editModelId}
              onChange={(event) => setEditModelId(event.target.value)}
              className="h-8 text-xs"
              placeholder="Model ID"
              onBlur={() => saveModel(editProvider, editModelId)}
              onKeyDown={(event) => {
                if (event.key === "Enter") saveModel(editProvider, editModelId);
              }}
            />
            {editProvider === "custom" && (
              <Input
                value={editCustomBaseUrl}
                onChange={(event) => setEditCustomBaseUrl(event.target.value)}
                className="h-8 text-xs"
                placeholder="https://api.example.com/v1"
                onBlur={() =>
                  saveModel(editProvider, editModelId, editCustomBaseUrl)
                }
                onKeyDown={(event) => {
                  if (event.key === "Enter")
                    saveModel(editProvider, editModelId, editCustomBaseUrl);
                }}
              />
            )}
            <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
              <Select
                items={
                  environmentVariables?.map((entry) => ({
                    value: entry.name,
                    label: entry.name,
                  })) ?? []
                }
                value={selectedApiKeyVariable ? trimmedApiKeyName : ""}
                onValueChange={(value) => {
                  if (value === null) return;
                  setEditProviderApiKeyName(value);
                  setProviderApiKeyError(null);
                  saveModel(
                    editProvider,
                    editModelId,
                    editCustomBaseUrl,
                    value,
                  );
                }}
              >
                <SelectTrigger className="h-8 min-w-0 cursor-pointer text-xs">
                  <SelectValue placeholder={`${providerLabel} API Key`} />
                </SelectTrigger>
                <SelectContent>
                  {(environmentVariables ?? []).map((entry) => (
                    <SelectItem key={entry.name} value={entry.name}>
                      {entry.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                value={editProviderApiKeyName}
                onChange={(event) => {
                  setEditProviderApiKeyName(event.target.value);
                  setProviderApiKeyError(null);
                }}
                className="h-8 min-w-0 font-mono text-xs"
                placeholder="ENV_VAR_NAME"
                onBlur={() =>
                  saveModel(
                    editProvider,
                    editModelId,
                    editCustomBaseUrl,
                    editProviderApiKeyName,
                  )
                }
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    saveModel(
                      editProvider,
                      editModelId,
                      editCustomBaseUrl,
                      editProviderApiKeyName,
                    );
                  }
                }}
              />
            </div>
            <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
              <Input
                type="password"
                value={newProviderApiKeyValue}
                onChange={(event) =>
                  setNewProviderApiKeyValue(event.target.value)
                }
                className="h-8 min-w-0 font-mono text-xs"
                placeholder="Paste value"
              />
              <Button
                variant="outline"
                size="sm"
                className="h-8 cursor-pointer gap-1.5 px-2 text-xs"
                disabled={
                  trimmedApiKeyName.length === 0 || isSavingProviderApiKey
                }
                onClick={saveInlineProviderApiKey}
              >
                <KeyRound className="size-3.5" />
                {isSavingProviderApiKey ? "Saving" : "Save"}
              </Button>
            </div>
            {apiKeyStatus === "ready" && (
              <p className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
                <Check className="size-3.5" />
                {trimmedApiKeyName} is ready for {providerLabel}.
              </p>
            )}
            {apiKeyStatus === "empty" && (
              <p className="text-xs text-destructive">
                {trimmedApiKeyName} exists in Environment variables, but its
                value is empty.
              </p>
            )}
            {apiKeyStatus === "not-found" && (
              <p className="text-xs text-destructive">
                {trimmedApiKeyName} was not found in Environment variables for
                this stage.
              </p>
            )}
            {apiKeyStatus === "missing" && (
              <p className="text-xs text-muted-foreground">
                No {providerLabel} API key selected.
              </p>
            )}
            {apiKeyStatus === "loading" && (
              <p className="text-xs text-muted-foreground">
                Checking {trimmedApiKeyName} in Environment variables.
              </p>
            )}
            {providerApiKeyError && (
              <p className="text-xs text-destructive">{providerApiKeyError}</p>
            )}
          </div>

          {/* Reasoning — budget tokens (Anthropic/MiniMax/Google) + effort (OpenAI/Anthropic),
                        written to model.providerOptions.<provider> for the selected provider. */}
          {onUpdateModelReasoning && (
            <div className="flex flex-col gap-2">
              <ToggleRow
                label="Reasoning"
                description="Thinking / extended reasoning"
                checked={reasoningEnabled}
                onCheckedChange={(next) => {
                  if (next) {
                    // Seed a provider-appropriate default so the toggle has effect:
                    // OpenAI reasons by effort, the others by a thinking-token budget.
                    if (selectedProvider === "openai") {
                      void onUpdateModelReasoning({ effort: "medium" });
                    } else {
                      setReasoningBudgetText("4096");
                      void onUpdateModelReasoning({ budgetTokens: 4096 });
                    }
                  } else {
                    setReasoningBudgetText("");
                    void onUpdateModelReasoning({});
                  }
                }}
              />
              {reasoningEnabled && (
                <ExpandBlock>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-[11px] text-muted-foreground">
                      Budget tokens{" "}
                      <span className="text-muted-foreground">
                        (Anthropic / MiniMax / Google)
                      </span>
                    </span>
                    <Input
                      type="number"
                      min={0}
                      className="h-7 w-24 text-xs"
                      placeholder="4096"
                      value={reasoningBudgetText}
                      onChange={(e) => setReasoningBudgetText(e.target.value)}
                      onBlur={() => {
                        const n = parseInt(reasoningBudgetText, 10);
                        const budget =
                          Number.isFinite(n) && n > 0 ? n : undefined;
                        void onUpdateModelReasoning({
                          budgetTokens: budget,
                          effort: reasoningEffort || undefined,
                        });
                      }}
                    />
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-[11px] text-muted-foreground">
                      Effort{" "}
                      <span className="text-muted-foreground">
                        (OpenAI / Anthropic)
                      </span>
                    </span>
                    <Select
                      items={REASONING_EFFORT_LABELS}
                      value={reasoningEffort || "none"}
                      onValueChange={(v) => {
                        const effort = !v || v === "none" ? undefined : v;
                        const n = parseInt(reasoningBudgetText, 10);
                        const budget =
                          Number.isFinite(n) && n > 0 ? n : undefined;
                        void onUpdateModelReasoning({
                          budgetTokens: budget,
                          effort: effort,
                        });
                      }}
                    >
                      <SelectTrigger className="h-7 w-28 cursor-pointer text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {Object.entries(REASONING_EFFORT_LABELS).map(
                          ([value, label]) => (
                            <SelectItem key={value} value={value}>
                              {label}
                            </SelectItem>
                          ),
                        )}
                      </SelectContent>
                    </Select>
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    Set budget for Anthropic/MiniMax/Google, effort for OpenAI.
                    Anthropic honors either.
                  </p>
                </ExpandBlock>
              )}
            </div>
          )}
        </>
      )}

      <Separator />

      {onUpdatePolicyConfig && (
        <>
          <div className="flex flex-col gap-3">
            <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
              Runtime Policy
            </span>
            <p className="text-[11px] text-muted-foreground">
              Each policy carries its own mode: audit records decisions without
              blocking, enforce blocks the tool calls it denies. Set it on the
              policy in Settings.
            </p>
            <div className="flex flex-col gap-1.5">
              {(policyOptions ?? []).map((policy) => {
                const selected = assignedPolicyIds.includes(policy._id);

                return (
                  <Button
                    key={policy._id}
                    type="button"
                    variant={selected ? "secondary" : "outline"}
                    size="sm"
                    className="h-8 justify-start truncate text-xs"
                    onClick={() => togglePolicyId(policy._id)}
                  >
                    {policy.name}
                  </Button>
                );
              })}
              {policyOptions && policyOptions.length === 0 && (
                <p className="rounded-md border border-border bg-muted/40 px-2.5 py-2 text-xs text-muted-foreground">
                  No policies in this stage.
                </p>
              )}
            </div>
          </div>

          <Separator />
        </>
      )}

      {/* Public access controls */}
      <div className="flex flex-col gap-3">
        <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
          Public API
        </span>
        {onUpdatePublicAccess && (
          <ToggleRow
            label="Public access"
            description="Reachable over HTTP/SSE and WebSocket with the runtime API key"
            checked={publicAccess}
            onCheckedChange={(next) => void onUpdatePublicAccess(next)}
          />
        )}
        <div className="rounded-lg border border-border/70 bg-muted/20 p-3">
          <p className="text-[11px] text-muted-foreground">
            {publicAccess
              ? "This agent is reachable over HTTP/SSE and WebSocket with the stage's runtime API key. Select the agent per request with its Agent ID below."
              : "Secured by default — this agent is not publicly accessible. Reach it through an internal endpoint or a channel webhook, or enable public access above."}
          </p>
        </div>

        {!activeDeployment ? (
          <div className="flex flex-col gap-2 rounded-md border border-dashed border-border/70 bg-muted/40 p-3">
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-foreground">
              <KeyRound className="size-3.5" />
              No runtime API key yet
            </span>
            <p className="text-[11px] text-muted-foreground">
              Generate the stage&apos;s key to reveal the endpoint URLs.{" "}
              <code>broods deploy</code> also mints it automatically.
            </p>
            <Button
              size="sm"
              variant="outline"
              className="h-8 w-fit cursor-pointer text-xs"
              disabled={isSavingKey}
              onClick={() => void onGenerateKey?.()}
            >
              {isSavingKey ? "Generating…" : "Generate API key"}
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-2.5">
            {!publicAccess ? (
              <p className="rounded-md border border-border bg-muted/40 px-2.5 py-2 text-xs text-muted-foreground">
                Endpoint URLs are hidden while public access is off. Requests to
                this agent over the public endpoint are refused until you enable
                public access above.
              </p>
            ) : !coreEndpoint.ok ? (
              <p className="rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-xs text-destructive">
                {coreEndpoint.message}
              </p>
            ) : (
              <>
                <div className="flex flex-col gap-1.5">
                  <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
                    Endpoint URL (HTTP/SSE)
                  </span>
                  <div className="flex items-center gap-2 rounded-md border border-border bg-muted/50 px-2.5 py-1.5">
                    <code className="flex-1 text-xs text-foreground break-all">
                      {endpointUrl}
                    </code>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="shrink-0 cursor-pointer text-muted-foreground"
                      onClick={() => handleCopy(endpointUrl, "url")}
                    >
                      {copiedField === "url" ? (
                        <Check className="size-3" />
                      ) : (
                        <Copy className="size-3" />
                      )}
                    </Button>
                  </div>
                </div>

                <div className="flex flex-col gap-1.5">
                  <span className="inline-flex items-center gap-1 text-[11px] uppercase tracking-wider text-muted-foreground">
                    <Wifi className="size-3" />
                    WebSocket URL
                  </span>
                  <div className="flex items-center gap-2 rounded-md border border-border bg-muted/50 px-2.5 py-1.5">
                    <code className="flex-1 text-xs text-foreground break-all">
                      {websocketUrl}
                    </code>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="shrink-0 cursor-pointer text-muted-foreground"
                      onClick={() => handleCopy(websocketUrl, "websocket")}
                    >
                      {copiedField === "websocket" ? (
                        <Check className="size-3" />
                      ) : (
                        <Copy className="size-3" />
                      )}
                    </Button>
                  </div>
                </div>
              </>
            )}

            {agentConfig?.agentId && (
              <div className="flex flex-col gap-1.5">
                <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
                  Agent ID
                </span>
                <div className="flex items-center gap-2 rounded-md border border-border bg-muted/50 px-2.5 py-1.5">
                  <code className="flex-1 text-xs text-foreground break-all">
                    {agentConfig.agentId}
                  </code>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="shrink-0 cursor-pointer text-muted-foreground"
                    onClick={() =>
                      handleCopy(agentConfig.agentId as string, "agentid")
                    }
                  >
                    {copiedField === "agentid" ? (
                      <Check className="size-3" />
                    ) : (
                      <Copy className="size-3" />
                    )}
                  </Button>
                </div>
                <span className="text-[11px] text-muted-foreground">
                  Pass this as <code>agentId</code> in the invoke payload.
                </span>
              </div>
            )}

            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
                  API Key (stage-wide)
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 cursor-pointer gap-1 px-1.5 text-[11px] text-muted-foreground"
                  disabled={isSavingKey}
                  onClick={() => setRotateOpen(true)}
                >
                  <RefreshCw
                    className={`size-3 ${isSavingKey ? "animate-spin" : ""}`}
                  />
                  Rotate
                </Button>
              </div>
              {deploymentApiKey ? (
                <div className="flex items-center gap-2 rounded-md border border-border bg-muted/50 px-2.5 py-1.5">
                  <code className="flex-1 text-xs text-foreground break-all">
                    {showApiKey ? deploymentApiKey : "\u2022".repeat(20)}
                  </code>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="shrink-0 cursor-pointer text-muted-foreground"
                    onClick={() => setShowApiKey(!showApiKey)}
                    aria-label={showApiKey ? "Hide API key" : "Show API key"}
                  >
                    {showApiKey ? (
                      <EyeOff className="size-3" />
                    ) : (
                      <Eye className="size-3" />
                    )}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="shrink-0 cursor-pointer text-muted-foreground"
                    onClick={() => handleCopy(deploymentApiKey, "apikey")}
                  >
                    {copiedField === "apikey" ? (
                      <Check className="size-3" />
                    ) : (
                      <Copy className="size-3" />
                    )}
                  </Button>
                </div>
              ) : (
                <p className="rounded-md border border-border bg-muted/40 px-2.5 py-2 text-xs text-muted-foreground">
                  Loading the encrypted runtime key…
                </p>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Built-in Tools */}
      {agentConfig && onUpdateToolConfig && (
        <>
          <Separator />
          <div className="flex flex-col gap-3">
            <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
              Provider Tools
            </span>

            {/* Google Search */}
            <ToggleRow
              label="Google Search"
              description={
                selectedProvider === "google"
                  ? "Grounded search via Google"
                  : "Requires Google provider"
              }
              checked={googleSearchEnabled}
              disabled={selectedProvider !== "google"}
              onCheckedChange={(next) =>
                void onUpdateToolConfig("googleSearch", {
                  ...googleSearchCfg,
                  enabled: next,
                })
              }
            />
            {googleSearchEnabled && selectedProvider === "google" && (
              <ExpandBlock>
                <ToggleRow
                  label="Needs approval"
                  checked={googleSearchCfg.needsApproval === true}
                  onCheckedChange={(next) =>
                    void onUpdateToolConfig("googleSearch", {
                      ...googleSearchCfg,
                      needsApproval: next,
                    })
                  }
                />
              </ExpandBlock>
            )}
          </div>
        </>
      )}

      {/* Output format schema */}
      {agentConfig && (
        <>
          <Separator />
          <div className="flex flex-col gap-3">
            <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
              Output Format
            </span>
            <div className="flex items-center justify-between">
              <div className="flex flex-col gap-0.5">
                <span className="text-xs font-medium text-foreground">
                  Structured Output
                </span>
                <span className="text-[11px] text-muted-foreground">
                  Import a JSON schema or write one manually
                </span>
              </div>
              <Switch
                checked={outputFormatEnabled}
                onCheckedChange={(checked) => handleToggleOutputFormat(checked)}
              />
            </div>

            {outputFormatEnabled && (
              <div className="ml-1 flex flex-col gap-2.5 border-l-2 border-border pl-3">
                <input
                  ref={schemaFileInputRef}
                  type="file"
                  accept="application/json,.json"
                  className="hidden"
                  onChange={(e) => {
                    handleImportSchemaFile(e.target.files?.[0]);
                    e.currentTarget.value = "";
                  }}
                />
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 text-[11px]"
                    onClick={() => schemaFileInputRef.current?.click()}
                  >
                    Import Schema
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 text-[11px]"
                    onClick={handleApplySchema}
                  >
                    Save Schema
                  </Button>
                </div>
                <Textarea
                  value={displayOutputSchemaText}
                  onChange={(e) => {
                    setHasEditedOutputSchema(true);
                    setOutputSchemaText(e.target.value);
                    setOutputSchemaError(null);
                  }}
                  placeholder={
                    '{\n  "type": "object",\n  "additionalProperties": true,\n  "properties": {\n    "answer": { "type": "string" }\n  },\n  "required": ["answer"]\n}'
                  }
                  spellCheck={false}
                  className="min-h-36 resize-y font-mono text-xs"
                />
                {outputSchemaError && (
                  <p className="text-xs text-destructive">
                    {outputSchemaError}
                  </p>
                )}
              </div>
            )}
          </div>
        </>
      )}

      {/* Channels — inbound webhook integrations on the agent's `channels` branch */}
      {agentConfig && onUpdateChannelConfig && (
        <>
          <Separator />
          <ChannelsSection
            agentConfig={agentConfig}
            onUpdateChannel={onUpdateChannelConfig}
          />
        </>
      )}

      <Dialog
        open={rotateOpen}
        onOpenChange={(open) => {
          setRotateOpen(open);
          if (!open) setRotateError(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Rotate the stage API key?</DialogTitle>
            <DialogDescription>
              This key is stage-wide. Every agent, channel webhook, and SDK
              client authenticating with the current key stops working the
              moment it is rotated, until you redeploy them with the new one.
              The old key cannot be recovered.
            </DialogDescription>
          </DialogHeader>
          {rotateError && (
            <p className="rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-xs text-destructive">
              {rotateError}
            </p>
          )}
          <DialogFooter showCloseButton>
            <Button
              variant="destructive"
              className="cursor-pointer disabled:cursor-not-allowed"
              disabled={isSavingKey}
              onClick={async () => {
                setRotateError(null);
                try {
                  // Close only on a confirmed rotation. A rejected mutation or
                  // an unconfigured stage must not read as success — the
                  // user would redeploy against a key that never changed.
                  const rotated = await onRotateKey?.();
                  if (rotated === false) {
                    setRotateError(
                      "This stage is not ready to issue a key yet. Save the agent first, then rotate.",
                    );

                    return;
                  }
                  setRotateOpen(false);
                } catch (err) {
                  setRotateError(toErrorMessage(err));
                }
              }}
            >
              {isSavingKey ? "Rotating…" : "Rotate key"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function readCustomBaseUrl(
  agentConfig: Doc<"agentConfigs"> | null | undefined,
): string {
  const extraConfig = isPlainObject(agentConfig?.extraConfig)
    ? agentConfig.extraConfig
    : {};
  const provider = isPlainObject(extraConfig.provider)
    ? extraConfig.provider
    : {};
  const custom = isPlainObject(provider.custom) ? provider.custom : {};
  const value =
    typeof custom.base_url === "string" ? custom.base_url : custom.baseURL;

  return typeof value === "string" ? value : "";
}

function readProviderApiKeyName(
  agentConfig: Doc<"agentConfigs"> | null | undefined,
  providerName: AgentProvider,
): string {
  const provider = (
    agentConfig?.extraConfig as
      | {
          provider?: AgentProviderConfig;
        }
      | undefined
  )?.provider;
  const apiKey = provider?.[providerName]?.apiKey;
  if (typeof apiKey !== "string") {
    return "";
  }

  const match = /^\$\{([^}]+)\}$/.exec(apiKey.trim());

  return match?.[1] ?? apiKey;
}
