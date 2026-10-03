/**
 * The principal a run acts as: one agent of one account, plus the delegation
 * chain that led to it (the person or key that asked, then each agent that
 * delegated). Built once where a Session is constructed, read by the policy
 * input, the audit ledger, the run's root span, sandbox env and MCP headers.
 * The link shape and the run-token prefix live in the convex model so the
 * ledger validates the same chain.
 */

import type { PrincipalLink } from "@broods/convex/model/principal";
import type { ChannelIdentity } from "../channels.ts";

export type { PrincipalLink } from "@broods/convex/model/principal";

export interface Principal {
  kind: "agent";
  accountId: string;
  agentId: string;
  runId?: string;
  conversationKey?: string;
  /** Oldest first: the requester, then every delegating agent before this one. */
  chain: PrincipalLink[];
}

/** The requester of a channel turn: the sender when the adapter identified one, else nobody. */
export function channelPrincipalChain(
  identity: ChannelIdentity | undefined,
  channelName: string,
): PrincipalLink[] {
  const user = userPrincipalLink(identity, channelName);

  return user ? [user] : [];
}

/** The chain a run this principal delegates to starts from: its own chain plus itself. */
export function delegatedChain(principal: Principal): PrincipalLink[] {
  return [...principal.chain, { kind: "agent", agentId: principal.agentId }];
}

/**
 * Who asked for a direct run. The router sets the chain for a request it
 * authenticated; a rebuilt envelope, a cron firing and a channel-bound
 * continuation are told apart by what the event carries.
 */
export function directPrincipalChain(event: {
  principalChain?: PrincipalLink[];
  cronRun?: unknown;
  replyTarget?: { channelName: string; identity?: ChannelIdentity };
  endpointId?: string;
}): PrincipalLink[] {
  if (event.principalChain) return event.principalChain;
  if (event.cronRun) return [{ kind: "api", keyKind: "cron" }];
  const user = event.replyTarget
    ? userPrincipalLink(
        event.replyTarget.identity,
        event.replyTarget.channelName,
      )
    : undefined;
  if (user) return [user];

  return [
    { kind: "api", keyKind: event.endpointId ? "deployment" : "account" },
  ];
}

/** `user:U1>agent:a1`, the chain and the principal as one span attribute. */
export function principalChainLabel(principal: Principal): string {
  return delegatedChain(principal).map(principalLinkLabel).join(">");
}

/** The principal a run acts as; undefined until the run names an account and an agent. */
export function runPrincipal(
  run: {
    accountId?: string;
    agentId?: string;
    eventId: string;
    conversationKey: string;
  },
  chain: PrincipalLink[],
): Principal | undefined {
  if (!run.accountId || !run.agentId) return undefined;

  return {
    kind: "agent",
    accountId: run.accountId,
    agentId: run.agentId,
    runId: run.eventId,
    conversationKey: run.conversationKey,
    chain: chain,
  };
}

/** The requester link of a channel turn; an identity with no user id is nobody. */
export function userPrincipalLink(
  identity: ChannelIdentity | undefined,
  channel: string,
): PrincipalLink | undefined {
  if (!identity?.userId) return undefined;

  return {
    kind: "user",
    id: identity.userId,
    ...(identity.userName ? { name: identity.userName } : {}),
    channel: channel,
  };
}

function principalLinkLabel(link: PrincipalLink): string {
  switch (link.kind) {
    case "user":
      return `user:${link.id}`;
    case "api":
      return `api:${link.keyKind}`;
    case "agent":
      return `agent:${link.agentId}`;
  }
}
