/**
 * SSE streaming client for the harness Function URL. Yields the payload of
 * each `data:` event from a synchronous direct API request.
 */

import { requireEnv } from "./client.ts";

// Stream SSE response from agent service
export async function* streamSSE(body: unknown, secret: string): AsyncGenerator<string> {
  const response = await fetch(requireEnv("AGENT_SERVICE_URL"), {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "text/event-stream", "Authorization": `Bearer ${secret}` },
    body: JSON.stringify(body),
  });

  if (!response.ok) throw new Error(`Request failed: ${response.status} ${await response.text()}`);
  if (!response.body) throw new Error("No response body");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let chunks = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        chunks += 1;
        yield line.slice(6);
      }
    }
    if (chunks === 0) {
      throw new Error("SSE stream ended without any data events");
    }
  } finally {
    reader.releaseLock();
  }
}
