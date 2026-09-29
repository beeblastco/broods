import type { BroodsAccount } from "../../../packages/broods/src/account.ts";
import { assertStep, type VerifyContext } from "../harness.ts";

/**
 * A GET on a webhook URL is a liveness check without a query string and a
 * subscription handshake with one (Meta's `hub.challenge`). The handshake must
 * reach core's channel scan through the gateway, query intact, instead of
 * getting the liveness answer.
 */
export async function webhookHandshake(context: VerifyContext): Promise<void> {
  const account = await context.measure(
    "load account",
    (): Promise<BroodsAccount> => context.account.getAccount(),
  );
  const url = context.client.accountWebhookUrl(account.accountId, "whatsapp");

  const live = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  assertStep(
    "a bare GET on a webhook URL answers live",
    live.status === 200,
    `${live.status} ${await live.text()}`,
  );

  const handshake = await context.measure(
    "whatsapp handshake",
    (): Promise<Response> =>
      fetch(
        `${url}?hub.mode=subscribe&hub.verify_token=${context.runId}&hub.challenge=42`,
        { signal: AbortSignal.timeout(10_000) },
      ),
  );
  const body = await handshake.text();
  assertStep(
    "a handshake GET reaches the channel scan, which finds no WhatsApp agent",
    handshake.status === 503 && body.includes("whatsapp"),
    `${handshake.status} ${body.slice(0, 200)}`,
  );
}
