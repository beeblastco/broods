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

// Core dedups by message id, so retrying a POST that did land is harmless.
const DISCORD_FORWARD_ATTEMPTS = 3;
const RETRY_CEILING_MS = 4_000;

export interface ForwardTarget {
  agentId: string;
  agentName: string;
  webhookUrl: string;
}

export interface ForwardAuth {
  /** Default 1: Matrix's sync loop awaits each delivery and retries from its outbox. */
  attempts?: number;
  header: string;
  timeoutMs: number;
  token: string;
}

/** Never throws. Resolves the webhook URLs whose last attempt failed in a retryable way. */
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
  let retryAfterMs = Number.NaN;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (attempt > 1) {
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
          [auth.header]: auth.token,
        },
        body: body,
        // The gateway never redirects, so a redirect would hand the token header to another host.
        redirect: "error",
        signal: AbortSignal.timeout(auth.timeoutMs),
      });
      if (response.ok) return true;
      const retryable =
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
          tokenHint: tokenHint(auth.token),
        });

        return !retryable;
      }
      // Seconds form only; an HTTP-date parses to NaN and falls back to the backoff.
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
          tokenHint: tokenHint(auth.token),
        });
      }
    }
  }

  return false;
}
