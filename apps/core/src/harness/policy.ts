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
  PolicyDecision,
  PolicyDecisionInput,
  PolicyDocument,
  PolicyMode,
} from "../shared/domain/policy.ts";
import { optionalEnv } from "../shared/env.ts";
import { logDebug, logInfo, logWarn } from "../shared/log.ts";
import { AGENT_POLICY_ACTIONS } from "@broods/convex/model/policyRules";
import { COMPUTER_READ_ACTIONS } from "../shared/machine-socket.ts";
import { getStorage } from "../shared/storage.ts";
import type {
  ResolvedAgentSandbox,
  ResolvedWorkspace,
} from "../shared/workspaces.ts";
import {
  bashNeedsApproval,
  bashSandboxTarget,
  computerSandboxTarget,
  editNeedsApproval,
  machineSandboxes,
  resolveWorkspace,
  targetsAgentSandbox,
  toWorkspaceRelative,
} from "./tools/filesystem-utils.ts";
import { MEMORY_DIR, memorySlug } from "./tools/memory.tool.ts";

// httpPolicyClient exposes no timeout/AbortSignal, and the OPA round-trip sits
// on the tool-approval path: a hung OPA endpoint would stall gated tool
// execution. A rejected evaluation fails closed inside opaPolicy.
const OPA_EVALUATE_TIMEOUT_MS = 3000;

/** Rego entrypoint. Both the per-tool approval and the invoke gate use it. */
const POLICY_DECISION_PATH = "broods/authz/decision";

const POLICY_INPUT_MAX_DEPTH = 4;
const POLICY_INPUT_MAX_ARRAY = 20;
const POLICY_INPUT_MAX_STRING = 500;
const POLICY_INPUT_PREVIEW_MAX = 160;
const POLICY_REDACTED_VALUE = "[redacted]";
const SENSITIVE_INPUT_KEY =
  /(api[_-]?key|authorization|bearer|credential|password|secret|token)/i;

// A policy only ever refuses, so a reference that resolves to nothing must not
// read as "no policy": it refuses everything until the reference is fixed.
const UNRESOLVED_POLICY: PolicyDocument = {
  version: 1,
  mode: "enforce",
  rules: [
    {
      id: "unresolved-policy",
      effect: "deny",
      actions: [...AGENT_POLICY_ACTIONS],
    },
  ],
};

type RuntimeToolApproval = Extract<
  ToolApprovalConfiguration<ToolSet, unknown>,
  (...args: never[]) => unknown
>;

// Lifts the channel's place and person onto the policy input. The rego resolves
// any dotted path, so these are usable in rule conditions with no engine change.
// userRoles is always present: a negated operator needs the attribute to match.
export function channelPolicyIdentity(
  identity: ChannelIdentity | undefined,
): Pick<
  PolicyDecisionInput,
  "channelId" | "threadId" | "userId" | "userName" | "userRoles"
> {
  return {
    ...(identity?.channelId ? { channelId: identity.channelId } : {}),
    ...(identity?.threadId ? { threadId: identity.threadId } : {}),
    ...(identity?.userId ? { userId: identity.userId } : {}),
    ...(identity?.userName ? { userName: identity.userName } : {}),
    userRoles: identity?.userRoles ?? [],
  };
}

export function compatibilityApprovalStatus(
  toolName: string,
  input: unknown,
  options: {
    configuredApprovals: ReadonlyMap<string, true>;
    workspaces: ResolvedWorkspace[];
    sandboxes?: ResolvedAgentSandbox[];
  },
): ToolApprovalStatus {
  const record =
    input && typeof input === "object"
      ? (input as Record<string, unknown>)
      : {};
  const workspace =
    typeof record.workspace === "string" ? record.workspace : undefined;
  const onSandbox = bashSandboxTarget(record.sandbox);

  if (toolName === "bash") {
    // A `sandbox` that is no name resolves nowhere, so it asks like an unknown name.
    if (record.sandbox !== undefined && onSandbox === undefined) {
      return "user-approval";
    }

    return bashNeedsApproval(
      { workspaces: options.workspaces, sandboxes: options.sandboxes },
      { workspace: workspace, sandbox: onSandbox },
    )
      ? "user-approval"
      : undefined;
  }

  // Looking is free; any other action asks like bash does, on the computer the
  // call names rather than on whatever the agent's own sandbox happens to be.
  if (toolName === "computer") {
    if (COMPUTER_READ_ACTIONS.has(String(record.action))) {
      return undefined;
    }
    const machine = computerSandboxTarget(
      machineSandboxes(options.sandboxes),
      record.sandbox,
    );

    return machine?.sandbox.permissionMode !== "bypass"
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

export async function createPolicyToolApproval(
  agentConfig: AgentConfig,
  baseInput: Omit<PolicyDecisionInput, "action">,
  workspaces: ResolvedWorkspace[],
  options: {
    mcpIdsByName?: ReadonlyMap<string, string>;
    sandboxes?: ResolvedAgentSandbox[];
  } = {},
): Promise<RuntimeToolApproval | undefined> {
  if (!isPolicyEnabled(agentConfig) || !baseInput.accountId) return undefined;
  const documents = await loadPolicyDocuments(
    baseInput.accountId,
    agentConfig.policies ?? [],
  );
  const mode: PolicyMode = enforcingMode(documents);

  const client = policyClient();
  const approval = shadow(
    opaPolicy({
      client: client,
      path: POLICY_DECISION_PATH,
      toInput: ({ toolCall }) => ({
        ...baseInput,
        ...policyInputForTool(
          toolCall.toolName,
          toolCall.input,
          workspaces,
          options,
        ),
        policies: documents,
      }),
    }),
    {
      // The rego already applied each policy's own mode, so a deny that arrives
      // here is one an enforcing policy meant. This flag only still matters when
      // OPA cannot be reached: a place with nothing enforcing must stay open.
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
          mode: mode,
          reason: reason,
          toolName: event.toolCall.toolName,
        });
        const data = {
          accountId: baseInput.accountId,
          agentId: baseInput.agentId,
          toolName: event.toolCall.toolName,
          toolCallId: event.toolCall.toolCallId,
          action: policyInput.action,
          decision: event.decision.type,
          mode: mode,
          enforced: event.enforced,
          reason: reason,
          toolInputKeys: policyInput.tool?.inputKeys,
          toolInputPreview: policyInput.tool?.inputPreview,
          mcpId: policyInput.mcpId,
          workspaceId: policyInput.workspaceId,
          workspaceName: policyInput.workspaceName,
          filePath: policyInput.filePath,
          skillPath: policyInput.skillPath,
          subagentId: policyInput.subagentId,
          // A rule conditioned on the actor is undebuggable without the actor
          // the decision actually read.
          channelId: baseInput.channelId,
          userId: baseInput.userId,
          userRoles: baseInput.userRoles,
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

export function createRuntimeToolApproval(options: {
  configuredApprovals: ReadonlyMap<string, true>;
  workspaces: ResolvedWorkspace[];
  sandboxes?: ResolvedAgentSandbox[];
  policyApproval?: RuntimeToolApproval;
}): RuntimeToolApproval | undefined {
  const hasCompatibilityApprovals =
    options.configuredApprovals.size > 0 ||
    options.workspaces.some((workspace) => workspace.sandbox) ||
    (options.sandboxes?.length ?? 0) > 0;

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

// Gates the turn before it starts: may this person address the agent here?
// Audit records only; enforce denies, including on an unreachable OPA.
export async function evaluateChannelInvoke(
  agentConfig: AgentConfig,
  input: Omit<PolicyDecisionInput, "action">,
): Promise<PolicyDecision | undefined> {
  if (!isPolicyEnabled(agentConfig) || !input.accountId) return undefined;
  try {
    // Loading the documents sits inside the try on purpose: a control-plane
    // blip must fail closed like an unreachable OPA, not throw past the caller.
    const policies = await loadPolicyDocuments(
      input.accountId,
      agentConfig.policies ?? [],
    );
    const mode = enforcingMode(policies);
    const decision = await policyClient().evaluate<
      PolicyDecisionInput & { policies: PolicyDocument[] },
      {
        allowed?: boolean;
        reason?: string;
        matchedRuleIds?: string[];
        auditedRuleIds?: string[];
      }
    >(POLICY_DECISION_PATH, {
      ...input,
      action: "agent.invoke",
      policies: policies,
    });

    return {
      // No decision means OPA does not carry the package: only a place where
      // nothing enforces stays open, as the tool gate does.
      allowed: decision ? decision.allowed === true : mode === "audit",
      mode: mode,
      reason: decision?.reason ?? "No allow policy rule matched",
      matchedRuleIds: decision?.matchedRuleIds ?? [],
      auditedRuleIds: decision?.auditedRuleIds ?? [],
    };
  } catch (error) {
    logWarn("Channel invoke policy evaluation failed", {
      accountId: input.accountId,
      agentId: input.agentId,
      channelId: input.channelId,
      error: error instanceof Error ? error.message : String(error),
    });

    // Fail closed: when the document load is what threw, there is no way to
    // tell an auditing place from an enforcing one here.
    return {
      allowed: false,
      mode: "enforce",
      reason: "Policy evaluation failed",
      matchedRuleIds: [],
      auditedRuleIds: [],
    };
  }
}

export function isPolicyEnabled(agentConfig: AgentConfig): boolean {
  return (agentConfig.policies?.length ?? 0) > 0;
}

export function policyDecisionLogMessage(input: {
  action?: string;
  decision: string;
  enforced: boolean;
  inputPreview?: string;
  mode: PolicyMode;
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

export function policyInputForTool(
  toolName: string,
  input: unknown,
  workspaces: ResolvedWorkspace[],
  options: {
    mcpIdsByName?: ReadonlyMap<string, string>;
    sandboxes?: ResolvedAgentSandbox[];
  } = {},
): Pick<
  PolicyDecisionInput,
  | "action"
  | "toolName"
  | "mcpId"
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
  const sandboxTarget = bashSandboxTarget(record.sandbox);
  // A bash call that runs on an agent-level sandbox touches no workspace, so it must
  // not be described to the policy as if it did. A workspace-scoped rule would then
  // authorize a run that never lands there. Resolve the same target execution will.
  const workspaceTarget =
    typeof record.workspace === "string" ? record.workspace : undefined;
  const onAgentSandbox =
    toolName === "bash" &&
    targetsAgentSandbox(
      { workspaces: workspaces, sandboxes: options.sandboxes },
      { workspace: workspaceTarget, sandbox: sandboxTarget },
    );
  const workspace = onAgentSandbox
    ? undefined
    : resolveWorkspaceForPolicy(workspaces, workspaceTarget);
  // A sandbox carries its own permissionMode, and that is the one fact a policy can
  // use to tell one sandbox from another. An unnamed call runs on the default, so it
  // reports the same mode as naming the default does.
  const picked = onAgentSandbox
    ? sandboxTarget === undefined
      ? options.sandboxes?.[0]
      : options.sandboxes?.find(
          (entry): boolean => entry.name === sandboxTarget,
        )
    : undefined;
  // grep and glob search from `path`; the regex is not a file.
  const searches = toolName === "grep" || toolName === "glob";
  const rawPath = searches ? record.path : record.file_path;
  const filePath =
    typeof rawPath === "string" ? policyFilePath(rawPath, searches) : undefined;
  const base = {
    toolName: toolName,
    ...(options.mcpIdsByName?.get(toolName)
      ? { mcpId: options.mcpIdsByName.get(toolName)! }
      : {}),
    tool: toolContextForPolicy(input),
    ...(workspace
      ? {
          workspaceId: workspace.workspaceId,
          workspaceName: workspace.name,
          sandboxPermissionMode: workspace.sandbox?.permissionMode,
        }
      : {}),
    ...(picked?.sandbox.permissionMode
      ? { sandboxPermissionMode: picked.sandbox.permissionMode }
      : {}),
    ...(filePath ? { filePath: filePath } : {}),
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
      ...(skillPath ? { skillPath: skillPath } : {}),
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
      ...(subagentId ? { subagentId: subagentId } : {}),
    };
  }

  return { action: "tool.call", ...base };
}

/**
 * Summary stage for a set of attached policies, matching what the rego decides:
 * the place is enforcing as soon as one policy attached to it enforces.
 */
function enforcingMode(documents: PolicyDocument[]): PolicyMode {
  return documents.some((document) => document.mode === "enforce")
    ? "enforce"
    : "audit";
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

async function loadPolicyDocuments(
  accountId: string,
  policyIds: string[],
): Promise<PolicyDocument[]> {
  const requested = [...new Set(policyIds)];
  const records = await Promise.all(
    requested.map((policyId) =>
      getStorage().agentPolicies.getById(accountId, policyId),
    ),
  );
  const missing = requested.filter((_, index) => !records[index]);
  if (missing.length > 0) {
    logWarn("Policy references did not resolve", {
      accountId: accountId,
      policyIds: missing,
    });
  }

  return records.map((record) => record?.document ?? UNRESOLVED_POLICY);
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

// The form the tools resolve, and a search root ends in `/` so `secrets/` matches
// it. A traversal stays raw: the SDK calls toInput outside its try, so no throw.
function policyFilePath(rawPath: string, searchRoot: boolean): string {
  try {
    const path = toWorkspaceRelative(rawPath);

    return searchRoot && path !== "." ? `${path}/` : path;
  } catch {
    return rawPath;
  }
}

function resolveWorkspaceForPolicy(
  workspaces: ResolvedWorkspace[],
  workspaceName: string | undefined,
): ResolvedWorkspace | undefined {
  try {
    return resolveWorkspace(workspaces, workspaceName);
  } catch (error) {
    // Workspace-scoped selectors cannot match without this context, so make
    // the miss visible before enforcement mode relies on it.
    logDebug("Policy workspace resolution failed", {
      workspaceName: workspaceName,
      error: error instanceof Error ? error.message : String(error),
    });

    return undefined;
  }
}

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

function truncatePolicyString(value: string): string {
  return value.length > POLICY_INPUT_MAX_STRING
    ? `${value.slice(0, POLICY_INPUT_MAX_STRING)}...`
    : value;
}

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
