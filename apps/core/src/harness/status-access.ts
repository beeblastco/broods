/**
 * Deployment-key authorization for status/attach reads. A child subagent read
 * is allowed only through its already-authorized, active, public parent.
 */

import {
  USER_CONVERSATION_PREFIX,
  userOwnsConversation,
  type UserToken,
} from "@broods/convex/model/userToken";
import type { StageTicketScope } from "../shared/auth.ts";
import type { AgentRecord } from "../shared/domain/agents.ts";
import {
  parseAccountAgentScopedKey,
  publicConversationKeyFromScoped,
  subagentParentEventId,
} from "../shared/runtime-keys.ts";
import type { AgentDeploymentScope } from "../shared/storage.ts";
import type { AsyncAgentResultRecord } from "./async-agent-result.ts";
import type { IngressStatusRecord } from "./ingress.ts";

export interface StatusAccessAuth {
  account: { accountId: string };
  endpointId: string;
  stageSlug: string;
  projectSlug: string;
  /** A member's ticket, which runs the stage's private agents too. */
  stageTicket?: StageTicketScope;
  /** The signed end user a runtime key's request speaks for. */
  user?: UserToken;
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
  ingressStatusByEventIdLoader(options: {
    accountId: string;
    agentId: string;
    eventId: string;
  }): Promise<IngressStatusRecord | null>;
}

export interface StatusAccessDenial {
  code:
    | "public_access_disabled"
    | "status_access_denied"
    | "user_token_required";
  message: string;
}

export interface StatusAccessRequest {
  accountId: string;
  agentId: string;
  eventId: string;
  publicEventId: string;
  /** The run's envelope, already resolved by run id before this check runs. */
  ingress: IngressStatusRecord;
}

export function deploymentScopeMatches(
  auth: StatusAccessAuth,
  deployment: AgentDeploymentScope | null,
): boolean {
  return (
    deployment?.accountId === auth.account.accountId &&
    deployment.endpointId === auth.endpointId &&
    deployment.projectSlug === auth.projectSlug &&
    deployment.stageSlug === auth.stageSlug
  );
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
  // A ticket may POST a run on a private agent of its stage, so it may also
  // read that run back; publicAccess only opens an agent to the frontend key.
  if (!agent || (agent.config.publicAccess !== true && !auth.stageTicket)) {
    return {
      code: "public_access_disabled",
      message: `Agent ${request.agentId} is not publicly accessible.`,
    };
  }
  const userDenial = embeddableUserDenial(
    auth,
    agent,
    request.ingress.conversationKey,
  );
  if (userDenial) return userDenial;
  const deployment = await context.deploymentLoader(
    request.accountId,
    request.agentId,
  );

  return deploymentScopeMatches(auth, deployment) &&
    deploymentScopeMatches(
      auth,
      request.ingress.publicDeploymentIngress ?? null,
    )
    ? null
    : accessDenied();
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

  // The parent must pass the gate its own status read does: an active agent
  // (public, unless a ticket reads it) on this deployment, with a live ingress row.
  const [parentAgent, parentDeployment, parentStatus] = await Promise.all([
    context.agentLoader(request.accountId, parentScope.agentId),
    context.deploymentLoader(request.accountId, parentScope.agentId),
    context.ingressStatusByEventIdLoader({
      accountId: request.accountId,
      agentId: parentScope.agentId,
      eventId: parentEventId,
    }),
  ]);
  if (
    !parentAgent ||
    (parentAgent.config.publicAccess !== true && !auth.stageTicket) ||
    !deploymentScopeMatches(auth, parentDeployment) ||
    !parentStatus ||
    parentStatus.eventId !== parentEventId ||
    !deploymentScopeMatches(auth, parentStatus.publicDeploymentIngress ?? null)
  ) {
    return accessDenied();
  }

  // The child is read through its parent, so the parent's conversation must
  // be one this caller's user may read.
  return embeddableUserDenial(auth, parentAgent, parentStatus.conversationKey);
}

/**
 * Whether the embeddable key may touch a direct conversation by its public
 * key: with a user token only that user's own, without one none that lives in
 * any user's namespace. Runs, approvals, steering and reads all go through it.
 */
export function embeddableKeyReaches(
  user: UserToken | undefined,
  publicConversationKey: string,
): boolean {
  return user
    ? userOwnsConversation(user, publicConversationKey)
    : !publicConversationKey.startsWith(USER_CONVERSATION_PREFIX);
}

/**
 * The runtime key's user rule for reading one run: an agent that requires a
 * user token answers only with one, and the run's conversation must be one
 * `embeddableKeyReaches` allows. A member's ticket reads the whole stage.
 */
function embeddableUserDenial(
  auth: StatusAccessAuth,
  agent: AgentRecord,
  scopedConversationKey: string,
): StatusAccessDenial | null {
  if (auth.stageTicket) return null;
  if (agent.requireUserToken === true && !auth.user) {
    return {
      code: "user_token_required",
      message: `Agent ${agent.agentId} requires a signed user token with the runtime key.`,
    };
  }
  // A key scoped to another account or agent keeps its prefix here, so it
  // never reads as a user's namespace.
  const publicKey = publicConversationKeyFromScoped(
    scopedConversationKey,
    auth.account.accountId,
    agent.agentId,
  );

  return embeddableKeyReaches(auth.user, publicKey) ? null : accessDenied();
}

function accessDenied(): StatusAccessDenial {
  return {
    code: "status_access_denied",
    message: "Status is not accessible from this deployment.",
  };
}
