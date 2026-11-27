import type { PrincipalLink } from "@broods/convex/model/principal";
import type { ChannelIdentity } from "../channels.ts";

export type { PrincipalLink } from "@broods/convex/model/principal";

export interface Principal {
  kind: "agent";
  accountId: string;
  agentId: string;
  /** Requester first, then each delegating agent. Never guessed: the ledger hashes it. */
  chain?: PrincipalLink[];
}

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

export function principalChainLabel(principal: Principal): string | undefined {
  return delegatedChain(principal)?.map(principalLinkLabel).join(">");
}

export function runPrincipal(
  run: { accountId?: string; agentId?: string },
  chain: PrincipalLink[] | undefined,
): Principal | undefined {
  if (!run.accountId || !run.agentId) return undefined;

  return {
    kind: "agent",
    accountId: run.accountId,
    agentId: run.agentId,
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
