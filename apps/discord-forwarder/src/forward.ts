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

import { backoffDelayMs } from "./backoff.ts";
import {
  FETCH_TIMEOUT_MS,
  type ForwardedThread,
  type MessageCreate,
} from "./discord.ts";
import { logError, logWarn, type LogFields, tokenHint } from "./log.ts";

// Core dedups a Discord message by its id, so retrying a POST that did land
// the first time is harmless.
const DISCORD_FORWARD_ATTEMPTS = 3;
const RETRY_CEILING_MS = 4_000;

export interface ForwardTarget {
  agentId: string;
  agentName: string;
  webhookUrl: string;
}

/**
 * How a forwarder authenticates itself to the channel webhook, and how hard it
 * tries. `attempts` defaults to 1. Matrix keeps that: its sync loop awaits each
 * delivery, so retries against a dead core would stall every room behind it.
 */
export interface ForwardAuth {
  attempts?: number;
  header: string;
  timeoutMs: number;
  token: string;
}

/**
 * Delivers one body to every target at once. Never throws: a webhook that still
 * rejects or times out on its last attempt is logged and skipped, so one dead
 * agent cannot stall the socket or sync loop waiting on it. `fields` adds
 * channel detail to those two log lines.
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
    attempts: DISCORD_FORWARD_ATTEMPTS,
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
  const attempts = auth.attempts ?? 1;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (attempt > 1) {
      await Bun.sleep(backoffDelayMs(attempt - 2, RETRY_CEILING_MS));
    }
    const last = attempt === attempts;
    try {
      const response = await fetch(target.webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [auth.header]: auth.token,
        },
        body: body,
        // The forwarder's token rides the header above, and the gateway never
        // redirects, so a redirect here would hand the token to another host.
        redirect: "error",
        signal: AbortSignal.timeout(auth.timeoutMs),
      });
      if (response.ok) return;
      // A 4xx answers the same way every time, so only a 5xx earns a retry.
      if (last || response.status < 500) {
        logWarn("Forward rejected by core", {
          ...fields,
          agentId: target.agentId,
          agentName: target.agentName,
          attempts: attempt,
          status: response.status,
          tokenHint: tokenHint(auth.token),
        });

        return;
      }
    } catch (error) {
      if (last) {
        logError("Forward failed", {
          ...fields,
          agentId: target.agentId,
          agentName: target.agentName,
          attempts: attempt,
          error: error instanceof Error ? error.message : String(error),
          tokenHint: tokenHint(auth.token),
        });
      }
    }
  }
}
