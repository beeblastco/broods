/**
 * MEASUREMENT ONLY, never merged. Core preload that passes every
 * api.openai.com call through and appends each response's input and cached
 * token counts to /tmp/openai-usage.jsonl, with the request's first system
 * line so the cache case can tell its conversations apart.
 */

import { appendFileSync } from "node:fs";

const LOG = "/tmp/openai-usage.jsonl";
const realFetch = globalThis.fetch;

interface Usage {
  input_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
}

globalThis.fetch = Object.assign(
  async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = input instanceof Request ? input.url : input.toString();
    const response = await realFetch(input, init);
    if (new URL(url).hostname !== "api.openai.com" || !response.body)
      return response;
    const body = typeof init?.body === "string" ? init.body : "";
    const tag = /\[measure:([a-z0-9-]+)\]/.exec(body)?.[1] ?? "other";
    const marks = (body.match(/prompt_cache_breakpoint/g) ?? []).length;
    const [forCore, forLog] = response.body.tee();
    void new Response(forLog).text().then((text) => {
      let usage: Usage | undefined;
      for (const line of text.split("\n")) {
        if (!line.startsWith("data:") || !line.includes('"usage"')) continue;
        try {
          const event = JSON.parse(line.slice(5)) as {
            response?: { usage?: Usage };
          };
          usage = event.response?.usage ?? usage;
        } catch {}
      }
      if (!usage) {
        try {
          usage = (JSON.parse(text) as { usage?: Usage }).usage;
        } catch {}
      }
      appendFileSync(
        LOG,
        `${JSON.stringify({ tag: tag, marks: marks, status: response.status, input: usage?.input_tokens ?? 0, cached: usage?.input_tokens_details?.cached_tokens ?? 0 })}\n`,
      );
    });

    return new Response(forCore, response);
  },
  realFetch,
);
