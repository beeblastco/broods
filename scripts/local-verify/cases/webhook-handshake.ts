import type { BroodsAccount } from "../../../packages/broods/src/account.ts";
import { assertStep, type VerifyContext } from "../harness.ts";

// Meta's channels share one handshake that core answers alike, so WhatsApp stands for all.
const CHANNEL = "whatsapp";

export async function webhookHandshake(context: VerifyContext): Promise<void> {
  const account = await context.measure(
    "load account",
    (): Promise<BroodsAccount> => context.account.getAccount(),
  );
  const handshakeQuery = `?hub.mode=subscribe&hub.verify_token=${context.runId}&hub.challenge=42`;
  const get = (target: string): Promise<Response> =>
    fetch(target, { signal: AbortSignal.timeout(10_000) });

  const url = context.client.accountWebhookUrl(account.accountId, CHANNEL);
  const live = await get(url);
  assertStep(
    "a bare GET on a webhook answers live",
    live.status === 200,
    `${live.status} ${await live.text()}`,
  );

  // Only the channel scan loads the account, so a 404 proves the query got past liveness.
  const unknown = await context.measure("handshake", (): Promise<Response> =>
    get(
      `${context.client.accountWebhookUrl(`missing${context.runId}`, CHANNEL)}${handshakeQuery}`,
    ),
  );
  assertStep(
    "a handshake GET reaches the channel scan",
    unknown.status === 404,
    `${unknown.status} ${(await unknown.text()).slice(0, 200)}`,
  );

  const unclaimed = await get(`${url}${handshakeQuery}`);
  assertStep(
    "a handshake no agent claims still answers live",
    unclaimed.status === 200,
    `${unclaimed.status} ${(await unclaimed.text()).slice(0, 200)}`,
  );
}
