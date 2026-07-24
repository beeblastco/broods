/**
 * Deployment-key authorization for status/attach reads. A child subagent read
 * is allowed only through its already-authorized, active, public parent.
 */

import type { AgentRecord } from "../shared/domain/agents.ts";
import {
  parseAccountAgentScopedKey,
  subagentParentEventId,
} from "../shared/runtime-keys.ts";
import type { AgentDeploymentScope } from "../shared/storage.ts";
import type { AsyncAgentResultRecord } from "./async-agent-result.ts";
import type { IngressStatusRecord } from "./ingress.ts";

export interface StatusAccessAuth {
  account: { accountId: string };
  endpointId: string;
  environmentSlug: string;
  projectSlug: string;
}

export interface StatusAccessContext {
  agentLoader(accountId: string, agentId: string): Promise<AgentRecord | null>;
  asyncAgentResultLoader(
    eventId: string,
  ): Promise<AsyncAgentResultRecord | null>;
  deploymentLoader(
    accountId: string,
    agentId: string,
  ): Promise<AgentDeploymentScope | null>;
  ingressStatusLoader(options: {
    accountId: string;
    agentId: string;
    eventId: string;
  }): Promise<IngressStatusRecord | null>;
}

export interface StatusAccessDenial {
  code: "public_access_disabled" | "status_access_denied";
  message: string;
}

export interface StatusAccessRequest {
  accountId: string;
  agentId: string;
  eventId: string;
  publicEventId: string;
}

export async function statusAccessDenial(
  auth: StatusAccessAuth,
  request: StatusAccessRequest,
  context: StatusAccessContext,
): Promise<StatusAccessDenial | null> {
  const parentEventId = subagentParentEventId(request.publicEventId);
  return parentEventId
    ? subagentDenial(auth, request, parentEventId, context)
    : publicAgentDenial(auth, request, context);
}

async function publicAgentDenial(
  auth: StatusAccessAuth,
  request: StatusAccessRequest,
  context: StatusAccessContext,
): Promise<StatusAccessDenial | null> {
  const agent = await context.agentLoader(request.accountId, request.agentId);
  if (
    !agent ||
    agent.status !== "active" ||
    agent.config.publicAccess !== true
  ) {
    return {
      code: "public_access_disabled",
      message: `Agent ${request.agentId} is not publicly accessible.`,
    };
  }
  const deployment = await context.deploymentLoader(
    request.accountId,
    request.agentId,
  );
  return deploymentScopeMatches(auth, deployment) ? null : accessDenied();
}

async function subagentDenial(
  auth: StatusAccessAuth,
  request: StatusAccessRequest,
  parentEventId: string,
  context: StatusAccessContext,
): Promise<StatusAccessDenial | null> {
  // The child row proves the runtime created this exact task for this scope.
  const childResult = await context.asyncAgentResultLoader(request.eventId);
  const childScope = childResult
    ? parseAccountAgentScopedKey(childResult.conversationKey)
    : null;
  if (
    !childResult ||
    childResult.accountId !== request.accountId ||
    childResult.eventId !== request.eventId ||
    childScope?.accountId !== request.accountId ||
    childScope.agentId !== request.agentId ||
    !childScope.key.startsWith("api:")
  ) {
    return accessDenied();
  }

  const parentScope = parseAccountAgentScopedKey(parentEventId);
  if (!parentScope || parentScope.accountId !== request.accountId) {
    return accessDenied();
  }

  // The parent must be an active public agent, on this deployment, with a live
  // ingress row — the same gate the parent's own status read passes.
  const [parentAgent, parentDeployment, parentStatus] = await Promise.all([
    context.agentLoader(request.accountId, parentScope.agentId),
    context.deploymentLoader(request.accountId, parentScope.agentId),
    context.ingressStatusLoader({
      accountId: request.accountId,
      agentId: parentScope.agentId,
      eventId: parentEventId,
    }),
  ]);
  if (
    !parentAgent ||
    parentAgent.status !== "active" ||
    parentAgent.config.publicAccess !== true ||
    !deploymentScopeMatches(auth, parentDeployment) ||
    !parentStatus ||
    parentStatus.eventId !== parentEventId
  ) {
    return accessDenied();
  }

  return null;
}

function accessDenied(): StatusAccessDenial {
  return {
    code: "status_access_denied",
    message: "Status is not accessible from this deployment.",
  };
}

function deploymentScopeMatches(
  auth: StatusAccessAuth,
  deployment: AgentDeploymentScope | null,
): boolean {
  return (
    deployment?.accountId === auth.account.accountId &&
    deployment.endpointId === auth.endpointId &&
    deployment.projectSlug === auth.projectSlug &&
    deployment.environmentSlug === auth.environmentSlug
  );
}
