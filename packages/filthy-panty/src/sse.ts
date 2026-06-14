/**
 * Direct SSE streaming against the harness Function URL using an account
 * secret. Yields each raw `data:` payload. Higher-level callers should prefer
 * `FilthyPantyClient.stream`, which decodes these into typed AI SDK parts.
 */

import { DEFAULT_CORE_BASE_URL, normalizeHttpServiceUrl, readSseStream } from "./client.ts";

export async function* streamSSE(body: unknown, secret: string): AsyncGenerator<string> {
  const baseUrl = normalizeHttpServiceUrl(
    process.env.FILTHY_PANTY_BASE_URL ||
    process.env.FILTHY_PANTY_HOST ||
    process.env.FILTHY_PANTY_AGENT_SERVICE_URL ||
    process.env.FILTHY_PANTY_HARNESS_URL ||
    process.env.AGENT_SERVICE_URL ||
    DEFAULT_CORE_BASE_URL,
  );
  const response = await fetch(baseUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "text/event-stream",
      "Authorization": `Bearer ${secret}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) throw new Error(`Request failed: ${response.status} ${await response.text()}`);
  if (!response.body) throw new Error("No response body");

  yield* readSseStream(response.body);
}
