/**
 * Shared direct-run stream contracts and SSE parsing helpers.
 */

import type { TextStreamPart, ToolSet } from "ai";

export type AgentStreamPart = TextStreamPart<ToolSet> | {
  type: "structured-output";
  output: unknown;
};

/** Yield the payload of each `data:` line from an SSE response body. */
export async function* readSseStream(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("data: ")) yield line.slice(6);
      }
    }
  } finally {
    reader.releaseLock();
  }
}
