// Core preload for `local-stack up --perf`: answers api.anthropic.com in process so perf
// times Broods, not the model, and traces core's Convex calls to BROODS_LOCAL_CONVEX_TRACE.

import { appendFileSync } from "node:fs";

const CONVEX_URL = process.env.CONVEX_URL ?? "";
const TRACE_PATH = process.env.BROODS_LOCAL_CONVEX_TRACE ?? "";
const USAGE = { input_tokens: 100, output_tokens: 10 };

interface MessagesRequest {
  messages: { content: unknown }[];
  model: string;
  stream?: boolean;
  tools?: { name?: string }[];
}

const realFetch = globalThis.fetch;

globalThis.fetch = Object.assign(
  async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = input instanceof Request ? input.url : input.toString();
    const body = typeof init?.body === "string" ? init.body : "";
    if (new URL(url).hostname === "api.anthropic.com") {
      return fakeModel(JSON.parse(body));
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

function event(type: string, fields: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type: type, ...fields })}\n\n`;
}

function fakeModel(request: MessagesRequest): Response {
  const message = {
    id: `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    model: request.model,
    stop_sequence: null,
  };
  if (!request.stream) {
    return Response.json({
      ...message,
      content: [{ type: "text", text: "Summary." }],
      stop_reason: "end_turn",
      usage: USAGE,
    });
  }
  const last = request.tools?.some((tool) => tool.name === "bash")
    ? JSON.stringify(request.messages.at(-1)?.content)
    : "";
  const { block, delta, stopReason } =
    last.includes("RUN_BASH") && !last.includes('"tool_result"')
      ? {
          block: {
            type: "tool_use",
            id: `toolu_${Date.now()}`,
            name: "bash",
            input: {},
          },
          delta: {
            type: "input_json_delta",
            partial_json: JSON.stringify({ command: "hostname" }),
          },
          stopReason: "tool_use",
        }
      : {
          block: { type: "text", text: "" },
          delta: { type: "text_delta", text: "OK" },
          stopReason: "end_turn",
        };
  const frames = [
    event("message_start", {
      message: { ...message, content: [], stop_reason: null, usage: USAGE },
    }),
    event("content_block_start", { index: 0, content_block: block }),
    event("content_block_delta", { index: 0, delta: delta }),
    event("content_block_stop", { index: 0 }),
    event("message_delta", {
      delta: {
        stop_reason: stopReason,
        stop_sequence: null,
      },
      usage: { output_tokens: USAGE.output_tokens },
    }),
    event("message_stop", {}),
  ];

  return new Response(frames.join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}
