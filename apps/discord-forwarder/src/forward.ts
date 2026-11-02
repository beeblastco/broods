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
import { logError, logWarn, tokenHint } from "./log.ts";

// Core dedups by message id, so retrying a POST that did land is harmless.
const ATTEMPTS = 3;
const RETRY_CEILING_MS = 4_000;

export interface ForwardTarget {
  agentId: string;
  agentName: string;
  webhookUrl: string;
}

/** Never throws. Posts the event to every agent webhook this bot token serves. */
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
  const token = discordForwarderToken(botToken);

  await Promise.all(
    targets.map((target): Promise<void> => post(target, body, token)),
  );
}

async function post(
  target: ForwardTarget,
  body: string,
  token: string,
): Promise<void> {
  let retryAfterMs = Number.NaN;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    if (attempt > 1) {
      await Bun.sleep(
        Number.isFinite(retryAfterMs)
          ? Math.min(retryAfterMs, RETRY_CEILING_MS)
          : backoffDelayMs(attempt - 2, RETRY_CEILING_MS),
      );
      retryAfterMs = Number.NaN;
    }
    const last = attempt === ATTEMPTS;
    try {
      const response = await fetch(target.webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [DISCORD_GATEWAY_TOKEN_HEADER]: token,
        },
        body: body,
        // The gateway never redirects, so a redirect would hand the token header to another host.
        redirect: "error",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (response.ok) return;
      const retryable =
        response.status >= 500 ||
        response.status === 408 ||
        response.status === 429;
      if (last || !retryable) {
        logWarn("Forward rejected by core", {
          agentId: target.agentId,
          agentName: target.agentName,
          attempts: attempt,
          status: response.status,
          tokenHint: tokenHint(token),
        });

        return;
      }
      // Seconds form only; an HTTP-date parses to NaN and falls back to the backoff.
      retryAfterMs =
        Number(response.headers.get("retry-after") ?? Number.NaN) * 1_000;
    } catch (error) {
      if (last) {
        logError("Forward failed", {
          agentId: target.agentId,
          agentName: target.agentName,
          attempts: attempt,
          error: error instanceof Error ? error.message : String(error),
          tokenHint: tokenHint(token),
        });
      }
    }
  }
}
