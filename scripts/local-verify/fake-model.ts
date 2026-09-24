/**
 * Core preload for `local-stack up --perf`. Answers api.deepseek.com in
 * process, so a perf run times Broods and not the model, and appends every
 * core call to the local Convex backend to BROODS_LOCAL_CONVEX_TRACE so
 * `local-stack perf` can count round trips per turn. Never loaded outside the
 * local stack.
 */

import { appendFileSync } from "node:fs";

const CONVEX_URL = process.env.CONVEX_URL ?? "";
const TRACE_PATH = process.env.BROODS_LOCAL_CONVEX_TRACE ?? "";
const USAGE = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 };

interface ChatRequest {
  messages: { content?: unknown; role: string }[];
  stream?: boolean;
  tools?: { function: { name: string } }[];
}

const realFetch = globalThis.fetch;

globalThis.fetch = Object.assign(
  async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = input instanceof Request ? input.url : input.toString();
    const body = typeof init?.body === "string" ? init.body : "";
    if (new URL(url).hostname === "api.deepseek.com") {
      return fakeModel(JSON.parse(body) as ChatRequest);
    }
    if (TRACE_PATH && CONVEX_URL && url.startsWith(CONVEX_URL)) {
      appendFileSync(
        TRACE_PATH,
        `${JSON.stringify({ at: Date.now(), fn: /"path":"([^"]+)"/.exec(body)?.[1] ?? new URL(url).pathname })}\n`,
      );
    }

    return realFetch(input, init);
  },
  { preconnect: realFetch.preconnect },
);

function chunk(
  delta: Record<string, unknown>,
  finishReason: string | null,
): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl-local",
    object: "chat.completion.chunk",
    created: 0,
    model: "deepseek-flash",
    choices: [{ index: 0, delta: delta, finish_reason: finishReason }],
    usage: finishReason ? USAGE : undefined,
  })}\n\n`;
}

/** A DeepSeek chat completion: text, or one `bash` call when the user asks with RUN_BASH. */
function fakeModel(request: ChatRequest): Response {
  const last = request.messages.at(-1);
  const wantsBash =
    last?.role === "user" &&
    JSON.stringify(last.content).includes("RUN_BASH") &&
    request.tools?.some((tool) => tool.function.name === "bash") === true;
  if (!request.stream) {
    return Response.json({
      id: "chatcmpl-local",
      object: "chat.completion",
      created: 0,
      model: "deepseek-flash",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Summary." },
          finish_reason: "stop",
        },
      ],
      usage: USAGE,
    });
  }
  const frames = wantsBash
    ? [
        chunk({ role: "assistant", content: null }, null),
        chunk(
          {
            tool_calls: [
              {
                index: 0,
                id: `call_${Date.now()}`,
                type: "function",
                function: {
                  name: "bash",
                  arguments: JSON.stringify({ command: "hostname" }),
                },
              },
            ],
          },
          null,
        ),
        chunk({}, "tool_calls"),
      ]
    : [chunk({ role: "assistant", content: "OK" }, null), chunk({}, "stop")];

  return new Response(`${frames.join("")}data: [DONE]\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}
