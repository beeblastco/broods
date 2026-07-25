/**
 * AI SDK policy approval wiring.
 * OPA is the policy decision point. config.policy.mode picks the rollout
 * stage: audit records decisions without blocking, enforce acts on them.
 */

import {
  httpPolicyClient,
  opaPolicy,
  shadow,
  type PolicyClient,
} from "@ai-sdk/policy-opa";
import type {
  ToolApprovalConfiguration,
  ToolApprovalStatus,
  ToolSet,
} from "ai";
import type { ChannelIdentity } from "../shared/channels.ts";
import type { AgentConfig } from "../shared/domain/agent-config.ts";
import type {
  AgentPolicyMode,
  PolicyDecision,
  PolicyDecisionInput,
} from "../shared/domain/agent-policy.ts";
import type { SandboxPermissionMode } from "../shared/domain/sandbox-config.ts";
import { optionalEnv } from "../shared/env.ts";
import { logDebug, logInfo, logWarn } from "../shared/log.ts";
import { getStorage } from "../shared/storage.ts";
import type { ResolvedWorkspace } from "../shared/workspaces.ts";
import type { SandboxExecutorConfig } from "./sandbox/types.ts";
import {
  bashNeedsApproval,
  editNeedsApproval,
  resolveWorkspace,
} from "./tools/filesystem-utils.ts";
import { MEMORY_DIR, memorySlug } from "./tools/memory.tool.ts";

type RuntimeToolApproval = Extract<
  ToolApprovalConfiguration<ToolSet, unknown>,
  (...args: any[]) => unknown
>;

export function isPolicyEnabled(agentConfig: AgentConfig): boolean {
  return (agentConfig.policy?.policyIds?.length ?? 0) > 0;
}

/**
 * Lift a channel's place and person onto the policy input. The rego resolves any
 * dotted path on the input, so these become usable in rule conditions as soon as
 * they are present — "deny bash in C042 unless the actor is on-call" needs no
 * policy-engine change.
 */
export function channelPolicyIdentity(
  identity: ChannelIdentity | undefined,
): Pick<
  PolicyDecisionInput,
  "channelId" | "threadId" | "actorId" | "actorName" | "actorRoles"
> {
  if (!identity) return {};

  return {
    ...(identity.channelId ? { channelId: identity.channelId } : {}),
    ...(identity.threadId ? { threadId: identity.threadId } : {}),
    ...(identity.actorId ? { actorId: identity.actorId } : {}),
    ...(identity.actorName ? { actorName: identity.actorName } : {}),
    ...(identity.actorRoles?.length ? { actorRoles: identity.actorRoles } : {}),
  };
}

export async function createPolicyToolApproval(
  agentConfig: AgentConfig,
  baseInput: Omit<PolicyDecisionInput, "action">,
  workspaces: ResolvedWorkspace[],
  options: { toolIdsByName?: ReadonlyMap<string, string> } = {},
): Promise<RuntimeToolApproval | undefined> {
  if (!isPolicyEnabled(agentConfig) || !baseInput.accountId) return undefined;
  const mode: AgentPolicyMode = agentConfig.policy?.mode ?? "audit";
  const documents = await loadPolicyDocuments(
    baseInput.accountId,
    agentConfig.policy?.policyIds ?? [],
  );

  const client = policyClient();
  const approval = shadow(
    opaPolicy({
      client,
      path: POLICY_DECISION_PATH,
      toInput: ({ toolCall }) => ({
        ...baseInput,
        ...policyInputForTool(
          toolCall.toolName,
          toolCall.input,
          workspaces,
          options,
        ),
        mode,
        policies: documents,
      }),
    }),
    {
      enforce: mode === "enforce",
      onDecision: (event) => {
        const reason =
          "reason" in event.decision ? event.decision.reason : undefined;
        const policyInput = policyInputForTool(
          event.toolCall.toolName,
          event.toolCall.input,
          workspaces,
          options,
        );
        const message = policyDecisionLogMessage({
          action: policyInput.action,
          decision: event.decision.type,
          enforced: event.enforced,
          inputPreview: policyInput.tool?.inputPreview,
          mode,
          reason,
          toolName: event.toolCall.toolName,
        });
        const data = {
          accountId: baseInput.accountId,
          agentId: baseInput.agentId,
          toolName: event.toolCall.toolName,
          toolCallId: event.toolCall.toolCallId,
          action: policyInput.action,
          decision: event.decision.type,
          mode,
          enforced: event.enforced,
          reason,
          toolInputKeys: policyInput.tool?.inputKeys,
          toolInputPreview: policyInput.tool?.inputPreview,
          toolId: policyInput.toolId,
          workspaceId: policyInput.workspaceId,
          workspaceName: policyInput.workspaceName,
          filePath: policyInput.filePath,
          skillPath: policyInput.skillPath,
          subagentId: policyInput.subagentId,
        };
        if (event.decision.type === "approved") {
          logInfo(message, data);
        } else {
          logWarn(message, data);
        }
      },
    },
  );
  return typeof approval === "function"
    ? (approval as RuntimeToolApproval)
    : undefined;
}

/**
 * Ask the policies whether this person may address the agent here, before the
 * turn starts. Audit mode records the decision and lets the turn through, which
 * is how a rule is rolled out on a live channel. An unreachable OPA denies in
 * enforce mode, matching the tool-approval path.
 */
export async function evaluateChannelInvoke(
  agentConfig: AgentConfig,
  input: Omit<PolicyDecisionInput, "action">,
): Promise<PolicyDecision | undefined> {
  if (!isPolicyEnabled(agentConfig) || !input.accountId) return undefined;
  const mode: AgentPolicyMode = agentConfig.policy?.mode ?? "audit";

  try {
    // Loading the documents sits inside the try on purpose: a control-plane
    // blip must fail closed like an unreachable OPA, not throw past the caller.
    const policies = await loadPolicyDocuments(
      input.accountId,
      agentConfig.policy?.policyIds ?? [],
    );
    if (policies.length === 0) return undefined;

    const decision = await policyClient().evaluate<
      PolicyDecisionInput & { mode: AgentPolicyMode; policies: unknown[] },
      { allowed?: boolean; reason?: string; matchedRuleIds?: string[] }
    >(POLICY_DECISION_PATH, {
      ...input,
      action: "agent.invoke",
      mode,
      policies,
    });

    return {
      allowed: decision?.allowed !== false,
      mode,
      reason: decision?.reason ?? "No allow policy rule matched",
      matchedRuleIds: decision?.matchedRuleIds ?? [],
    };
  } catch (error) {
    logWarn("Channel invoke policy evaluation failed", {
      accountId: input.accountId,
      agentId: input.agentId,
      channelId: input.channelId,
      mode,
      error: error instanceof Error ? error.message : String(error),
    });

    return {
      allowed: false,
      mode,
      reason: "Policy evaluation failed",
      matchedRuleIds: [],
    };
  }
}

export function policyDecisionLogMessage(input: {
  action?: string;
  decision: string;
  enforced: boolean;
  inputPreview?: string;
  mode: AgentPolicyMode;
  reason?: string;
  toolName: string;
}): string {
  const action =
    input.decision === "denied" && !input.enforced
      ? "would deny"
      : input.decision;
  const details = [
    input.action ? `action ${input.action}` : undefined,
    input.inputPreview ? `input ${input.inputPreview}` : undefined,
  ]
    .filter(Boolean)
    .join(", ");
  const message = `Agent policy ${action} ${input.toolName} (${input.mode})${details ? `: ${details}` : ""}`;
  return input.reason ? `${message}: ${input.reason}` : message;
}

export function createRuntimeToolApproval(options: {
  configuredApprovals: ReadonlyMap<string, true>;
  workspaces: ResolvedWorkspace[];
  statelessSandbox?: SandboxExecutorConfig;
  statelessPermissionMode?: SandboxPermissionMode;
  policyApproval?: RuntimeToolApproval;
}): RuntimeToolApproval | undefined {
  const hasCompatibilityApprovals =
    options.configuredApprovals.size > 0 ||
    options.workspaces.some((workspace) => workspace.sandbox) ||
    Boolean(options.statelessSandbox);

  if (!hasCompatibilityApprovals && !options.policyApproval) return undefined;

  return async (event) => {
    const compatibility = compatibilityApprovalStatus(
      event.toolCall.toolName,
      event.toolCall.input,
      options,
    );
    if (compatibility) return compatibility;
    return options.policyApproval?.(event);
  };
}

export function compatibilityApprovalStatus(
  toolName: string,
  input: unknown,
  options: {
    configuredApprovals: ReadonlyMap<string, true>;
    workspaces: ResolvedWorkspace[];
    statelessSandbox?: SandboxExecutorConfig;
    statelessPermissionMode?: SandboxPermissionMode;
  },
): ToolApprovalStatus {
  const record =
    input && typeof input === "object"
      ? (input as Record<string, unknown>)
      : {};
  const workspace =
    typeof record.workspace === "string" ? record.workspace : undefined;

  if (toolName === "bash") {
    return bashNeedsApproval(
      {
        workspaces: options.workspaces,
        ...(options.statelessSandbox
          ? { statelessSandbox: options.statelessSandbox }
          : {}),
        ...(options.statelessPermissionMode
          ? { statelessPermissionMode: options.statelessPermissionMode }
          : {}),
      },
      workspace,
    )
      ? "user-approval"
      : undefined;
  }

  // memory_save writes workspace files (memory/*.md + the index), so it follows
  // the same approval path as write/edit.
  if (
    toolName === "write" ||
    toolName === "edit" ||
    toolName === "memory_save"
  ) {
    return editNeedsApproval(options.workspaces, workspace)
      ? "user-approval"
      : undefined;
  }

  return options.configuredApprovals.has(toolName)
    ? "user-approval"
    : undefined;
}

export function policyInputForTool(
  toolName: string,
  input: unknown,
  workspaces: ResolvedWorkspace[],
  options: { toolIdsByName?: ReadonlyMap<string, string> } = {},
): Pick<
  PolicyDecisionInput,
  | "action"
  | "toolName"
  | "toolId"
  | "workspaceId"
  | "workspaceName"
  | "filePath"
  | "skillPath"
  | "subagentId"
  | "sandboxPermissionMode"
  | "tool"
> {
  const record =
    input && typeof input === "object"
      ? (input as Record<string, unknown>)
      : {};
  const workspace = resolveWorkspaceForPolicy(
    workspaces,
    typeof record.workspace === "string" ? record.workspace : undefined,
  );
  const filePath =
    typeof record.file_path === "string"
      ? record.file_path
      : typeof record.pattern === "string"
        ? record.pattern
        : undefined;
  const base = {
    toolName,
    ...(options.toolIdsByName?.get(toolName)
      ? { toolId: options.toolIdsByName.get(toolName)! }
      : {}),
    tool: toolContextForPolicy(input),
    ...(workspace
      ? {
          workspaceId: workspace.workspaceId,
          workspaceName: workspace.name,
          sandboxPermissionMode: workspace.sandbox?.permissionMode,
        }
      : {}),
    ...(filePath ? { filePath } : {}),
  };

  if (toolName === "read" || toolName === "glob" || toolName === "grep")
    return { action: "workspace.read", ...base };
  if (toolName === "write" || toolName === "edit")
    return { action: "workspace.write", ...base };
  if (toolName === "memory_save") {
    // The tool derives its target path from the title, so mirror that here to give
    // policies the same workspace.write + filePath surface as write/edit.
    const title = typeof record.title === "string" ? record.title : "";
    return {
      action: "workspace.write",
      ...base,
      filePath: `${MEMORY_DIR}/${memorySlug(title)}.md`,
    };
  }
  if (toolName === "bash") return { action: "workspace.exec", ...base };
  if (toolName === "load_skill") {
    const skillPath = typeof record.path === "string" ? record.path : undefined;
    return {
      action: "skill.load",
      ...base,
      ...(skillPath ? { skillPath } : {}),
    };
  }
  if (toolName === "run_subagent") {
    const subagentId = Array.isArray(record.tasks)
      ? (
          record.tasks.find(
            (task) =>
              task &&
              typeof task === "object" &&
              typeof (task as { agentId?: unknown }).agentId === "string",
          ) as { agentId?: string } | undefined
        )?.agentId
      : undefined;
    return {
      action: "subagent.run",
      ...base,
      ...(subagentId ? { subagentId } : {}),
    };
  }

  return { action: "tool.call", ...base };
}

function toolContextForPolicy(
  input: unknown,
): NonNullable<PolicyDecisionInput["tool"]> {
  const sanitizedInput = sanitizePolicyToolInput(input);
  return {
    ...(sanitizedInput ? { input: sanitizedInput } : {}),
    ...(sanitizedInput
      ? { inputKeys: Object.keys(sanitizedInput).sort() }
      : {}),
    ...(sanitizedInput
      ? { inputPreview: formatPolicyInputPreview(sanitizedInput) }
      : {}),
  };
}

const POLICY_INPUT_MAX_DEPTH = 4;
const POLICY_INPUT_MAX_ARRAY = 20;
const POLICY_INPUT_MAX_STRING = 500;
const POLICY_INPUT_PREVIEW_MAX = 160;
const POLICY_REDACTED_VALUE = "[redacted]";
const SENSITIVE_INPUT_KEY =
  /(api[_-]?key|authorization|bearer|credential|password|secret|token)/i;

function sanitizePolicyToolInput(
  value: unknown,
  depth = 0,
): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const result = sanitizePolicyValue(value, depth);
  return result && typeof result === "object" && !Array.isArray(result)
    ? (result as Record<string, unknown>)
    : undefined;
}

function sanitizePolicyValue(value: unknown, depth: number): unknown {
  if (value == null || typeof value === "number" || typeof value === "boolean")
    return value;
  if (typeof value === "string") return truncatePolicyString(value);
  if (Array.isArray(value)) {
    if (depth >= POLICY_INPUT_MAX_DEPTH) return `[array:${value.length}]`;
    return value
      .slice(0, POLICY_INPUT_MAX_ARRAY)
      .map((entry) => sanitizePolicyValue(entry, depth + 1));
  }
  if (typeof value === "object") {
    if (depth >= POLICY_INPUT_MAX_DEPTH) return "[object]";
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(
      value as Record<string, unknown>,
    )) {
      output[key] = SENSITIVE_INPUT_KEY.test(key)
        ? POLICY_REDACTED_VALUE
        : sanitizePolicyValue(entry, depth + 1);
    }
    return output;
  }
  return String(value);
}

function truncatePolicyString(value: string): string {
  return value.length > POLICY_INPUT_MAX_STRING
    ? `${value.slice(0, POLICY_INPUT_MAX_STRING)}...`
    : value;
}

function formatPolicyInputPreview(input: Record<string, unknown>): string {
  return Object.entries(input)
    .slice(0, 6)
    .map(([key, value]) => `${key}=${formatPolicyPreviewValue(value)}`)
    .join(" ")
    .slice(0, POLICY_INPUT_PREVIEW_MAX);
}

function formatPolicyPreviewValue(value: unknown): string {
  if (typeof value === "string")
    return JSON.stringify(
      value.length > 80 ? `${value.slice(0, 80)}...` : value,
    );
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (Array.isArray(value)) return `[array:${value.length}]`;
  if (value && typeof value === "object") return "{object}";
  return String(value);
}

function resolveWorkspaceForPolicy(
  workspaces: ResolvedWorkspace[],
  workspaceName: string | undefined,
) {
  try {
    return resolveWorkspace(workspaces, workspaceName);
  } catch (error) {
    // Workspace-scoped selectors cannot match without this context, so make
    // the miss visible before enforcement mode relies on it.
    logDebug("Policy workspace resolution failed", {
      workspaceName,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

/** Rego entrypoint. Both the per-tool approval and the invoke gate use it. */
const POLICY_DECISION_PATH = "broods/authz/decision";

async function loadPolicyDocuments(
  accountId: string,
  policyIds: string[],
): Promise<unknown[]> {
  const records = await Promise.all(
    [...new Set(policyIds)].map((policyId) =>
      getStorage().agentPolicies.getById(accountId, policyId),
    ),
  );

  return records
    .filter((record): record is NonNullable<typeof record> => Boolean(record))
    .map((record) => record.document);
}

function policyClient(): PolicyClient {
  const opaToken = optionalEnv("OPA_API_TOKEN");

  return withEvaluationDeadline(
    httpPolicyClient({
      url: optionalEnv("OPA_BASE_URL") ?? "http://127.0.0.1:8181",
      ...(opaToken ? { headers: { authorization: `Bearer ${opaToken}` } } : {}),
    }),
    OPA_EVALUATE_TIMEOUT_MS,
  );
}

// httpPolicyClient exposes no timeout/AbortSignal, and the OPA round-trip sits
// on the tool-approval path: a hung OPA endpoint would stall gated tool
// execution. A rejected evaluation fails closed inside opaPolicy.
const OPA_EVALUATE_TIMEOUT_MS = 3000;

function withEvaluationDeadline(
  client: PolicyClient,
  timeoutMs: number,
): PolicyClient {
  return {
    evaluate: async <TInput, TResult>(
      path: string,
      input: TInput,
    ): Promise<TResult> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          client.evaluate<TInput, TResult>(path, input),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new Error(`OPA evaluation timed out after ${timeoutMs}ms`),
                ),
              timeoutMs,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
