/**
 * Deployment-key status authorization for public runs and parent-bound subagent tasks.
 * Keep this transport-neutral so gateway/core integration tests exercise the same policy.
 */

import {
  parseAccountAgentScopedKey,
  subagentParentEventId,
} from "../shared/runtime-keys.ts";
interface AgentAccessRecord {
  status: "active" | "disabled";
  config: { publicAccess?: boolean };
}

interface AsyncAgentAccessRecord {
  accountId: string;
  eventId: string;
  conversationKey: string;
}

interface DeploymentAccessScope {
  accountId: string;
  endpointId: string;
  environmentSlug: string;
  projectSlug: string;
}

interface IngressStatusAccessRecord {
  eventId: string;
}

export interface DeploymentStatusAccessContext {
  agentLoader(
    accountId: string,
    agentId: string,
  ): Promise<AgentAccessRecord | null>;
  asyncAgentResultLoader(
    eventId: string,
  ): Promise<AsyncAgentAccessRecord | null>;
  deploymentLoader(
    accountId: string,
    agentId: string,
  ): Promise<DeploymentAccessScope | null>;
  ingressStatusLoader(options: {
    accountId: string;
    agentId: string;
    eventId: string;
  }): Promise<IngressStatusAccessRecord | null>;
}

export interface DeploymentStatusAuth {
  account: { accountId: string };
  endpointId: string;
  environmentSlug: string;
  projectSlug: string;
}

export interface StatusAccessDenial {
  code: "public_access_disabled" | "status_access_denied";
  message: string;
}

export interface StatusAccessEvent {
  accountId: string;
  agentId: string;
  eventId: string;
  publicEventId: string;
}

export async function deploymentStatusAccessDenial(
  auth: DeploymentStatusAuth,
  event: StatusAccessEvent,
  context: DeploymentStatusAccessContext,
): Promise<StatusAccessDenial | null> {
  const parentEventId = subagentParentEventId(event.publicEventId);
  if (!parentEventId) {
    const agent = await context.agentLoader(event.accountId, event.agentId);
    if (
      !agent ||
      agent.status !== "active" ||
      agent.config.publicAccess !== true
    ) {
      return {
        code: "public_access_disabled",
        message: `Agent ${event.agentId} is not publicly accessible.`,
      };
    }
    const deployment = await context.deploymentLoader(
      event.accountId,
      event.agentId,
    );
    return deploymentScopeMatches(auth, deployment)
      ? null
      : statusAccessDenied();
  }

  const childResult = await context.asyncAgentResultLoader(event.eventId);
  const childConversationScope = childResult
    ? parseAccountAgentScopedKey(childResult.conversationKey)
    : null;
  if (
    !childResult ||
    childResult.accountId !== event.accountId ||
    childResult.eventId !== event.eventId ||
    childConversationScope?.accountId !== event.accountId ||
    childConversationScope.agentId !== event.agentId ||
    !childConversationScope.key.startsWith("api:")
  ) {
    return statusAccessDenied();
  }

  const parentScope = parseAccountAgentScopedKey(parentEventId);
  if (!parentScope || parentScope.accountId !== event.accountId) {
    return statusAccessDenied();
  }

  const [parentAgent, parentDeployment, parentStatus] = await Promise.all([
    context.agentLoader(event.accountId, parentScope.agentId),
    context.deploymentLoader(event.accountId, parentScope.agentId),
    context.ingressStatusLoader({
      accountId: event.accountId,
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
    return statusAccessDenied();
  }

  return null;
}

function deploymentScopeMatches(
  auth: DeploymentStatusAuth,
  deployment: DeploymentAccessScope | null,
): boolean {
  return (
    deployment?.accountId === auth.account.accountId &&
    deployment.endpointId === auth.endpointId &&
    deployment.projectSlug === auth.projectSlug &&
    deployment.environmentSlug === auth.environmentSlug
  );
}

function statusAccessDenied(): StatusAccessDenial {
  return {
    code: "status_access_denied",
    message: "Status is not accessible from this deployment.",
  };
}
