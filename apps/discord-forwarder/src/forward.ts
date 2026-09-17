/**
 * POSTs a gateway event to the channel webhooks that share the bot token it
 * arrived on. `fanOut` is the delivery every forwarder shares; Matrix calls it
 * too, from `apps/matrix-forwarder/src/forward.ts`.
 *
 * The payload is Discord's, unchanged, apart from the `thread` object Discord
 * omits (see `threads.ts`). In particular `author.bot` is left as Discord sent
 * it, absent for human authors, because core's `isGatewayMessage` accepts that
 * shape. Normalizing it here would put the same rule in two places and leave
 * every other forwarder still broken.
 */

import {
  FETCH_TIMEOUT_MS,
  type ForwardedThread,
  type MessageCreate,
} from "./discord.ts";
import { logError, logWarn, type LogFields, tokenHint } from "./log.ts";

export interface ForwardTarget {
  agentId: string;
  agentName: string;
  webhookUrl: string;
}

/** How a forwarder authenticates itself to the channel webhook. */
export interface ForwardAuth {
  header: string;
  timeoutMs: number;
  token: string;
}

/**
 * Delivers one body to every target at once. Never throws: a webhook that
 * rejects or times out is logged and skipped, so one dead agent cannot stall
 * the socket or sync loop waiting on it. `fields` adds channel detail to those
 * two log lines.
 */
export async function fanOut(
  targets: readonly ForwardTarget[],
  body: string,
  auth: ForwardAuth,
  fields: LogFields = {},
): Promise<void> {
  await Promise.all(
    targets.map((target): Promise<void> => post(target, body, auth, fields)),
  );
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

  await fanOut(targets, body, {
    header: "x-discord-gateway-token",
    timeoutMs: FETCH_TIMEOUT_MS,
    token: botToken,
  });
}

async function post(
  target: ForwardTarget,
  body: string,
  auth: ForwardAuth,
  fields: LogFields,
): Promise<void> {
  try {
    const response = await fetch(target.webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [auth.header]: auth.token,
      },
      body: body,
      signal: AbortSignal.timeout(auth.timeoutMs),
    });
    if (!response.ok) {
      logWarn("Forward rejected by core", {
        ...fields,
        agentId: target.agentId,
        agentName: target.agentName,
        status: response.status,
        tokenHint: tokenHint(auth.token),
      });
    }
  } catch (error) {
    logError("Forward failed", {
      ...fields,
      agentId: target.agentId,
      agentName: target.agentName,
      error: error instanceof Error ? error.message : String(error),
      tokenHint: tokenHint(auth.token),
    });
  }
}
