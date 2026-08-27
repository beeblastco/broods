/**
 * POSTs a gateway event to the channel webhooks that share the bot token it
 * arrived on.
 *
 * The payload is Discord's, unchanged, apart from the `thread` object Discord
 * omits (see `threads.ts`). In particular `author.bot` is left as Discord sent
 * it — absent for human authors — because core's `isGatewayMessage` accepts that
 * shape. Normalizing it here would put the same rule in two places and leave
 * every other forwarder still broken.
 */

import {
  FETCH_TIMEOUT_MS,
  type ForwardedThread,
  type MessageCreate,
} from "./discord.ts";
import { logError, logWarn, tokenHint } from "./log.ts";

export interface ForwardTarget {
  agentId: string;
  agentName: string;
  webhookUrl: string;
}

export async function forwardMessageCreate(
  data: MessageCreate,
  thread: ForwardedThread | null,
  botToken: string,
  targets: readonly ForwardTarget[],
): Promise<void> {
  const body = JSON.stringify({
    type: "GATEWAY_MESSAGE_CREATE",
    data: thread ? { ...data, thread: thread } : data,
  });

  await Promise.all(
    targets.map((target): Promise<void> => post(target, body, botToken)),
  );
}

async function post(
  target: ForwardTarget,
  body: string,
  botToken: string,
): Promise<void> {
  try {
    const response = await fetch(target.webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-discord-gateway-token": botToken,
      },
      body: body,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      logWarn("Forward rejected by core", {
        agentId: target.agentId,
        agentName: target.agentName,
        status: response.status,
        tokenHint: tokenHint(botToken),
      });
    }
  } catch (error) {
    logError("Forward failed", {
      agentId: target.agentId,
      agentName: target.agentName,
      error: error instanceof Error ? error.message : String(error),
      tokenHint: tokenHint(botToken),
    });
  }
}
