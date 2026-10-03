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
  /**
   * Oldest first: the requester, then every delegating agent before this one.
   * Absent when core does not know who asked. It is never guessed, because the
   * ledger hashes it.
   */
  chain?: PrincipalLink[];
}

/** The requester of a channel turn: the sender, when the adapter identified one. */
export function channelPrincipalChain(
  identity: ChannelIdentity | undefined,
  channelName: string,
): PrincipalLink[] | undefined {
  if (!identity?.userId) return undefined;

  return [
    {
      kind: "user",
      id: identity.userId,
      ...(identity.userName ? { name: identity.userName } : {}),
      channel: channelName,
    },
  ];
}

/**
 * The chain as it leaves core for a reader the account does not control (the
 * run token's payload, a remote MCP server): ids and kinds, never a display
 * name. The ledger and the OPA input keep the name.
 */
export function chainWithoutNames(chain: PrincipalLink[]): PrincipalLink[] {
  return chain.map((link): PrincipalLink => {
    if (link.kind !== "user") return link;
    const { name: _name, ...rest } = link;

    return rest;
  });
}

/** The chain a run this principal delegates to starts from: its own chain plus itself. Unknown stays unknown. */
export function delegatedChain(
  principal: Principal,
): PrincipalLink[] | undefined {
  return (
    principal.chain && [
      ...principal.chain,
      { kind: "agent", agentId: principal.agentId },
    ]
  );
}

/**
 * Who asked for a direct run: the chain the router or a sending run set, the
 * scheduler for a cron firing, or the sender a channel-bound envelope stored.
 * A rebuilt envelope that carries none of these has no known requester.
 */
export function directPrincipalChain(event: {
  principalChain?: PrincipalLink[];
  cronRun?: unknown;
  replyTarget?: { channelName: string; identity?: ChannelIdentity };
}): PrincipalLink[] | undefined {
  if (event.principalChain) return event.principalChain;
  if (event.cronRun) return [{ kind: "api", keyKind: "cron" }];

  return (
    event.replyTarget &&
    channelPrincipalChain(
      event.replyTarget.identity,
      event.replyTarget.channelName,
    )
  );
}

/** `user:U1>agent:a1`, the chain and the principal as one span attribute. */
export function principalChainLabel(principal: Principal): string | undefined {
  return delegatedChain(principal)?.map(principalLinkLabel).join(">");
}

/** The principal a run acts as; undefined until the run names an account and an agent. */
export function runPrincipal(
  run: {
    accountId?: string;
    agentId?: string;
    eventId: string;
    conversationKey: string;
  },
  chain: PrincipalLink[] | undefined,
): Principal | undefined {
  if (!run.accountId || !run.agentId) return undefined;

  return {
    kind: "agent",
    accountId: run.accountId,
    agentId: run.agentId,
    runId: run.eventId,
    conversationKey: run.conversationKey,
    ...(chain ? { chain: chain } : {}),
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
