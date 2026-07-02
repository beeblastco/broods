/**
 * AI SDK policy approval wiring.
 * OPA is the policy decision point; SDK shadow mode records decisions without
 * blocking tool execution while the policy rolls out.
 */

import type { ToolApprovalConfiguration, ToolApprovalStatus, ToolSet } from "ai";
import { httpPolicyClient, opaPolicy, shadow } from "@ai-sdk/policy-opa";
import { optionalEnv } from "../_shared/env.ts";
import { logWarn } from "../_shared/log.ts";
import {
  getStorage,
  type AgentConfig,
  type AgentPolicyMode,
  type PolicyDecisionInput,
  type SandboxPermissionMode,
} from "../_shared/storage/index.ts";
import type { ResolvedWorkspace } from "../_shared/workspaces.ts";
import type { SandboxExecutorConfig } from "./sandbox/types.ts";
import { bashNeedsApproval, editNeedsApproval, resolveWorkspace } from "./tools/filesystem-utils.ts";

type RuntimeToolApproval = Extract<ToolApprovalConfiguration<ToolSet, unknown>, (...args: any[]) => unknown>;

export function isPolicyEnabled(agentConfig: AgentConfig): boolean {
  return agentConfig.policy?.enabled === true && (agentConfig.policy.policyIds?.length ?? 0) > 0;
}

export async function createPolicyToolApproval(
  agentConfig: AgentConfig,
  baseInput: Omit<PolicyDecisionInput, "action">,
  workspaces: ResolvedWorkspace[],
): Promise<RuntimeToolApproval | undefined> {
  if (!isPolicyEnabled(agentConfig) || !baseInput.accountId) return undefined;
  const mode: AgentPolicyMode = "audit";
  const policyIds = [...new Set(agentConfig.policy?.policyIds ?? [])];
  const records = await Promise.all(policyIds.map((policyId) =>
    getStorage().agentPolicies.getById(baseInput.accountId!, policyId),
  ));
  const documents = records
    .filter((record): record is NonNullable<typeof record> => Boolean(record))
    .map((record) => record.document);

  const client = httpPolicyClient({ url: optionalEnv("OPA_BASE_URL") ?? "http://127.0.0.1:8181" });
  const approval = shadow(
    opaPolicy({
      client,
      path: "broods/authz/decision",
      toInput: ({ toolCall }) => ({
        ...baseInput,
        ...policyInputForTool(toolCall.toolName, toolCall.input, workspaces),
        mode,
        policies: documents,
      }),
    }),
    {
      onDecision: (event) => {
        if (event.decision.type === "approved") return;
        logWarn("Agent policy shadow decision", {
          accountId: baseInput.accountId,
          agentId: baseInput.agentId,
          toolName: event.toolCall.toolName,
          toolCallId: event.toolCall.toolCallId,
          decision: event.decision.type,
          reason: "reason" in event.decision ? event.decision.reason : undefined,
        });
      },
    },
  );
  return typeof approval === "function" ? approval as RuntimeToolApproval : undefined;
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
    const compatibility = compatibilityApprovalStatus(event.toolCall.toolName, event.toolCall.input, options);
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
  const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const workspace = typeof record.workspace === "string" ? record.workspace : undefined;

  if (toolName === "bash") {
    return bashNeedsApproval({
      workspaces: options.workspaces,
      ...(options.statelessSandbox ? { statelessSandbox: options.statelessSandbox } : {}),
      ...(options.statelessPermissionMode ? { statelessPermissionMode: options.statelessPermissionMode } : {}),
    }, workspace) ? "user-approval" : undefined;
  }

  if (toolName === "write" || toolName === "edit") {
    return editNeedsApproval(options.workspaces, workspace) ? "user-approval" : undefined;
  }

  return options.configuredApprovals.has(toolName) ? "user-approval" : undefined;
}

export function policyInputForTool(
  toolName: string,
  input: unknown,
  workspaces: ResolvedWorkspace[],
): Pick<
  PolicyDecisionInput,
  "action" | "toolName" | "workspaceId" | "workspaceName" | "filePath" | "skillPath" | "subagentId" | "sandboxPermissionMode"
> {
  const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const workspace = resolveWorkspaceForPolicy(workspaces, typeof record.workspace === "string" ? record.workspace : undefined);
  const filePath = typeof record.file_path === "string"
    ? record.file_path
    : typeof record.pattern === "string"
      ? record.pattern
      : undefined;
  const base = {
    toolName,
    ...(workspace ? {
      workspaceId: workspace.workspaceId,
      workspaceName: workspace.name,
      sandboxPermissionMode: workspace.sandbox?.permissionMode,
    } : {}),
    ...(filePath ? { filePath } : {}),
  };

  if (toolName === "read" || toolName === "glob" || toolName === "grep") return { action: "workspace.read", ...base };
  if (toolName === "write" || toolName === "edit") return { action: "workspace.write", ...base };
  if (toolName === "bash") return { action: "workspace.exec", ...base };
  if (toolName === "load_skill") {
    const skillPath = typeof record.path === "string" ? record.path : undefined;
    return { action: "skill.load", ...base, ...(skillPath ? { skillPath } : {}) };
  }
  if (toolName === "run_subagent") {
    const subagentId = Array.isArray(record.tasks)
      ? (record.tasks.find((task) =>
          task && typeof task === "object" && typeof (task as { agentId?: unknown }).agentId === "string"
        ) as { agentId?: string } | undefined)?.agentId
      : undefined;
    return { action: "subagent.run", ...base, ...(subagentId ? { subagentId } : {}) };
  }

  return { action: "tool.call", ...base };
}

function resolveWorkspaceForPolicy(workspaces: ResolvedWorkspace[], workspaceName: string | undefined) {
  try {
    return resolveWorkspace(workspaces, workspaceName);
  } catch {
    return undefined;
  }
}
