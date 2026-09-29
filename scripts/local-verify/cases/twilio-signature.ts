import { createHmac } from "node:crypto";
import type { CreateAgentResult } from "../../../packages/broods/src/account.ts";
import { assertStep, type VerifyContext } from "../harness.ts";

/**
 * Twilio signs the public URL it called, so core must see the path the gateway
 * received and check it against `PUBLIC_BASE_URL`. A delivery receipt is
 * signed and acknowledged without running the agent; a signature over any
 * other URL is refused.
 */
export async function twilioSignature(context: VerifyContext): Promise<void> {
  const authToken = `twilio-${context.runId}`;
  await context.measure("create twilio agent", (): Promise<CreateAgentResult> =>
    context.account.createAgent({
      name: `twilio-${context.runId}`,
      config: {
        ...context.model,
        channels: {
          twilio: {
            id: "sms",
            accountSid: "AC00000000000000000000000000000001",
            authToken: authToken,
            phoneNumber: "+15550001111",
          },
        },
      },
    }),
  );
  const account = await context.account.getAccount();
  const url = context.client.accountWebhookUrl(account.accountId, "twilio");
  const receipt = new URLSearchParams({
    AccountSid: "AC00000000000000000000000000000001",
    From: "+15550001111",
    MessageSid: `SM${context.runId}`,
    MessageStatus: "delivered",
    To: "+15551234567",
  });
  const send = (signedUrl: string): Promise<Response> =>
    fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": sign(signedUrl, receipt, authToken),
      },
      body: receipt.toString(),
      signal: AbortSignal.timeout(10_000),
    });

  const accepted = await context.measure(
    "signed twilio receipt",
    (): Promise<Response> => send(url),
  );
  const acceptedBody = await accepted.text();
  assertStep(
    "a receipt signed over the public URL is acknowledged with empty TwiML",
    accepted.status === 200 && acceptedBody === "<Response></Response>",
    `${accepted.status} ${acceptedBody.slice(0, 200)}`,
  );

  const internal = await send(
    `http://core.internal/v1/webhooks/${account.accountId}/twilio`,
  );
  assertStep(
    "a signature over the internal URL is refused",
    internal.status === 401,
    `${internal.status} ${(await internal.text()).slice(0, 200)}`,
  );
}

// Twilio's scheme: the URL, then every field name and value in name order,
// HMAC-SHA1 with the auth token, base64.
function sign(url: string, form: URLSearchParams, token: string): string {
  const base = [...form]
    .sort(([left], [right]): number => (left < right ? -1 : 1))
    .reduce((text, [name, value]): string => `${text}${name}${value}`, url);

  return createHmac("sha1", token).update(base).digest("base64");
}
