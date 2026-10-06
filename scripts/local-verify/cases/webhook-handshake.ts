import type { BroodsAccount } from "../../../packages/broods/src/account.ts";
import { assertStep, type VerifyContext } from "../harness.ts";

/**
 * A GET on a webhook URL is a liveness check, unless a channel claims it as a
 * subscription handshake (Meta's `hub.challenge`, which Instagram, Messenger
 * and WhatsApp share). A GET with a query must reach core's channel scan
 * through the gateway, query intact, and still get the liveness answer when
 * no channel claims it.
 */
export async function webhookHandshake(context: VerifyContext): Promise<void> {
  const account = await context.measure(
    "load account",
    (): Promise<BroodsAccount> => context.account.getAccount(),
  );
  const handshakeQuery = `?hub.mode=subscribe&hub.verify_token=${context.runId}&hub.challenge=42`;
  const get = (target: string): Promise<Response> =>
    fetch(target, { signal: AbortSignal.timeout(10_000) });

  for (const channel of ["instagram", "messenger", "whatsapp"] as const) {
    const url = context.client.accountWebhookUrl(account.accountId, channel);
    const live = await get(url);
    assertStep(
      `a bare GET on the ${channel} webhook answers live`,
      live.status === 200,
      `${live.status} ${await live.text()}`,
    );

    // Only the scan loads the account, so a 404 for an unknown one proves the
    // handshake got past the liveness answer.
    const unknown = await context.measure(
      `${channel} handshake`,
      (): Promise<Response> =>
        get(
          `${context.client.accountWebhookUrl(`missing${context.runId}`, channel)}${handshakeQuery}`,
        ),
    );
    assertStep(
      `the ${channel} handshake GET reaches the channel scan`,
      unknown.status === 404,
      `${unknown.status} ${(await unknown.text()).slice(0, 200)}`,
    );

    const unclaimed = await get(`${url}${handshakeQuery}`);
    assertStep(
      `the ${channel} handshake no agent claims still answers live`,
      unclaimed.status === 200,
      `${unclaimed.status} ${(await unclaimed.text()).slice(0, 200)}`,
    );
  }
}
