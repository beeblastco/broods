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
 *
 * The POST authenticates with the transport credential `discord-wire.ts`
 * derives from the bot token, so the token itself stays off the public edge.
 * A core that predates the derivation answers it with a 401; the retry with
 * the raw token below keeps messages flowing until that core has rolled.
 */

import {
  DISCORD_GATEWAY_TOKEN_HEADER,
  discordForwarderToken,
} from "../../core/src/shared/discord-wire.ts";
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
 * It retries from its outbox instead, for the targets `fanOut` resolves.
 */
export interface ForwardAuth {
  attempts?: number;
  /**
   * Retried once per target when `token` gets a 401: a core that predates the
   * derived Discord credential still expects the raw bot token. Remove
   * together with the raw-token fallback in core's `discord-channel.ts`.
   */
  fallbackToken?: string;
  header: string;
  timeoutMs: number;
  token: string;
}

/**
 * Delivers one body to every target at once. Never throws: a webhook that still
 * rejects or times out on its last attempt is logged and skipped, so one dead
 * agent cannot stall the socket or sync loop waiting on it. `fields` adds
 * channel detail to those two log lines.
 *
 * Resolves the webhook URLs whose target ended on a 5xx, a 408, a 429, a
 * timeout or a network error, which a later delivery of the same body can
 * still get through. Any other 4xx answers the same way every time, so it
 * counts as settled. Discord has no way to ask for an event again and ignores
 * the result; Matrix keeps the event in its outbox for those targets only.
 */
export async function fanOut(
  targets: readonly ForwardTarget[],
  body: string,
  auth: ForwardAuth,
  fields: LogFields = {},
): Promise<string[]> {
  const settled = await Promise.all(
    targets.map((target): Promise<boolean> => post(target, body, auth, fields)),
  );

  return targets
    .filter((_, index): boolean => !settled[index])
    .map((target): string => target.webhookUrl);
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
    fallbackToken: botToken,
    header: DISCORD_GATEWAY_TOKEN_HEADER,
    timeoutMs: FETCH_TIMEOUT_MS,
    token: discordForwarderToken(botToken),
  });
}

async function post(
  target: ForwardTarget,
  body: string,
  auth: ForwardAuth,
  fields: LogFields,
): Promise<boolean> {
  const attempts = auth.attempts ?? 1;
  let token = auth.token;
  let retryAfterMs = Number.NaN;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (attempt > 1) {
      // Retry-After is honoured up to the ceiling: past it the socket would
      // stall on one message, and the backoff stands in when it is absent.
      await Bun.sleep(
        Number.isFinite(retryAfterMs)
          ? Math.min(retryAfterMs, RETRY_CEILING_MS)
          : backoffDelayMs(attempt - 2, RETRY_CEILING_MS),
      );
      retryAfterMs = Number.NaN;
    }
    const last = attempt === attempts;
    try {
      const response = await fetch(target.webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [auth.header]: token,
        },
        body: body,
        // The forwarder's token rides the header above, and the gateway never
        // redirects, so a redirect here would hand the token to another host.
        redirect: "error",
        signal: AbortSignal.timeout(auth.timeoutMs),
      });
      if (response.ok) return true;
      // A 401 on the primary token earns one retry with the fallback (see
      // `ForwardAuth`). Any other 4xx answers the same way every time, except
      // a timeout and a rate limit, so only those and a 5xx earn a retry.
      const fallbackToken =
        response.status === 401 && token !== auth.fallbackToken
          ? auth.fallbackToken
          : undefined;
      const retryable =
        fallbackToken !== undefined ||
        response.status >= 500 ||
        response.status === 408 ||
        response.status === 429;
      if (last || !retryable) {
        logWarn("Forward rejected by core", {
          ...fields,
          agentId: target.agentId,
          agentName: target.agentName,
          attempts: attempt,
          status: response.status,
          tokenHint: tokenHint(token),
        });

        return !retryable;
      }
      if (fallbackToken !== undefined) {
        token = fallbackToken;
      }
      // Seconds only. The HTTP-date form parses to NaN and gets the backoff.
      retryAfterMs =
        Number(response.headers.get("retry-after") ?? Number.NaN) * 1_000;
    } catch (error) {
      if (last) {
        logError("Forward failed", {
          ...fields,
          agentId: target.agentId,
          agentName: target.agentName,
          attempts: attempt,
          error: error instanceof Error ? error.message : String(error),
          tokenHint: tokenHint(token),
        });
      }
    }
  }

  return false;
}
