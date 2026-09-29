import type { BroodsAccount } from "../../../packages/broods/src/account.ts";
import { assertStep, type VerifyContext } from "../harness.ts";

/**
 * A GET on a webhook URL is a liveness check without a query string and a
 * subscription handshake with one (X's `crc_token`). The handshake must
 * reach core's channel scan through the gateway, query intact, instead of
 * getting the liveness answer.
 */
export async function webhookHandshake(context: VerifyContext): Promise<void> {
  const account = await context.measure(
    "load account",
    (): Promise<BroodsAccount> => context.account.getAccount(),
  );
  const url = context.client.accountWebhookUrl(account.accountId, "x");

  const live = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  assertStep(
    "a bare GET on a webhook URL answers live",
    live.status === 200,
    `${live.status} ${await live.text()}`,
  );

  const handshake = await context.measure(
    "x crc handshake",
    (): Promise<Response> =>
      fetch(`${url}?crc_token=${context.runId}`, {
        signal: AbortSignal.timeout(10_000),
      }),
  );
  const body = await handshake.text();
  assertStep(
    "a handshake GET reaches the channel scan, which finds no X agent",
    handshake.status === 503 &&
      body.includes("x integration is not configured"),
    `${handshake.status} ${body.slice(0, 200)}`,
  );
}
