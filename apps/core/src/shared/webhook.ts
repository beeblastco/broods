/**
 * Shared outbound webhook delivery helpers.
 * Keep generic signing and HTTP callback logic here.
 */

import { createHmac } from "node:crypto";
import { guardedFetch } from "../harness/isolate/runner/pinned-fetch.mjs";
import { assertPublicHttpsUrl, type PinnedFetchTransport } from "./http.ts";

export interface WebhookConfig {
  url: string;
  secret: string;
}

export async function fireWebhook(
  config: WebhookConfig,
  payload: unknown,
  transport?: PinnedFetchTransport,
): Promise<void> {
  // Protocol only, because a name is all this can see: configs may predate
  // validation, and `guardedFetch` accepts http as well as https.
  assertPublicHttpsUrl(config.url, "webhook url");
  const body = JSON.stringify(payload);
  const signature = createWebhookSignature(config.secret, body);
  // The address is the boundary, not the name. `guardedFetch` resolves once,
  // refuses every private and metadata address the name resolves to, and pins
  // the socket to the address it validated, so a name that resolves publicly
  // during the check cannot resolve privately at connect. It revalidates each
  // redirect too, which is why the old `redirect: "error"` is gone.
  const response = await guardedFetch(
    config.url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Signature": signature,
      },
      body: body,
    },
    // No redirects: the payload and its signature go to the host the account
    // named or nowhere. Every hop would be revalidated, but http is a valid
    // hop, so following one could carry a signed payload off TLS.
    { ...transport, redirectLimit: 0 },
  );

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Webhook delivery failed with HTTP ${response.status}`);
  }
}

function createWebhookSignature(secret: string, body: string): string {
  const digest = createHmac("sha256", secret).update(body).digest("hex");

  return `sha256=${digest}`;
}
