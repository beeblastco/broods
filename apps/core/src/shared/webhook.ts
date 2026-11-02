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
  // guardedFetch pins checked public addresses but accepts http; https and no redirects keep
  // the signed payload on TLS.
  assertPublicHttpsUrl(config.url, "webhook url");
  const body = JSON.stringify(payload);
  const signature = createWebhookSignature(config.secret, body);
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
