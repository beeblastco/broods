/**
 * Direct SSE streaming against the harness Function URL using an account
 * secret. Yields each raw `data:` payload. Higher-level callers should prefer
 * `FilthyPantyClient.stream`, which decodes these into typed AI SDK parts.
 */

import { readSseStream } from "./client.ts";

export async function* streamSSE(body: unknown, secret: string): AsyncGenerator<string> {
  const response = await fetch(process.env.AGENT_SERVICE_URL!, {
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
