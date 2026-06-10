/**
 * Shared outbound webhook delivery helpers.
 * Keep generic signing and HTTP callback logic here.
 */

import { createHmac } from "node:crypto";
import { assertPublicHttpsUrl } from "./http.ts";

export interface WebhookConfig {
  url: string;
  secret: string;
}

export async function fireWebhook(config: WebhookConfig, payload: unknown): Promise<void> {
  // Re-checked at delivery (configs may predate validation); redirects are
  // refused so a public URL cannot 302 into a private address.
  assertPublicHttpsUrl(config.url, "webhook url");
  const body = JSON.stringify(payload);
  const signature = createWebhookSignature(config.secret, body);
  const response = await fetch(config.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Webhook-Signature": signature,
    },
    body,
    redirect: "error",
  });

  if (!response.ok) {
    throw new Error(`Webhook delivery failed with HTTP ${response.status}`);
  }
}

function createWebhookSignature(secret: string, body: string): string {
  const digest = createHmac("sha256", secret).update(body).digest("hex");
  return `sha256=${digest}`;
}
