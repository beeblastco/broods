/**
 * Core preload for `local-stack up --perf`. Answers api.anthropic.com in
 * process, so a perf run times Broods and not the model, and appends every
 * core call to the local Convex backend to BROODS_LOCAL_CONVEX_TRACE so
 * `local-stack perf` can count round trips per turn. Never loaded outside the
 * local stack.
 *
 * Triggers in the user message pick the first step's answer: `RUN_BASH` calls
 * `bash`, `ASYNC_STATUS:<statusId>` calls `async_status`. `ASYNC_STATUS_AFTER:
 * <ms>:<statusId>` waits before it answers, so `long-horizon` can queue a
 * resume behind the turn first. A history write that carries a tool result
 * for a statusId starting `async_tool_hold_` is held and never sent, so the
 * status read returns but its step is never saved, and `long-horizon` kills
 * core in that window.
 */

import { appendFileSync } from "node:fs";

const CONVEX_URL = process.env.CONVEX_URL ?? "";
const TRACE_PATH = process.env.BROODS_LOCAL_CONVEX_TRACE ?? "";
const USAGE = { input_tokens: 100, output_tokens: 10 };
const ASYNC_STATUS_TRIGGER = /ASYNC_STATUS(?:_AFTER:(\d+))?:([A-Za-z0-9_-]+)/;
const HELD_RESULT_PREFIX = "async_tool_hold_";
// What every result `long-horizon` seeds answers with.
const DELIVERED_RESULT_MARKER = "LHPAYLOAD-";

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
      const fn = /"path":"([^"]+)"/.exec(body)?.[1] ?? new URL(url).pathname;
      const held =
        body.includes(HELD_RESULT_PREFIX) && body.includes('"tool-result"');
      appendFileSync(
        TRACE_PATH,
        `${JSON.stringify({ at: Date.now(), fn: held ? `held:${fn}` : fn })}\n`,
      );
      if (held) return new Promise<Response>((): void => {});
    }

    return realFetch(input, init);
  },
  { preconnect: realFetch.preconnect },
);

function event(type: string, fields: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type: type, ...fields })}\n\n`;
}

interface FakeToolCall {
  name: string;
  input: Record<string, string>;
}

/** The tool call a first step answers with, when the last user message asks for one. */
function toolCallFor(
  last: string,
  tools: Set<string>,
): { call: FakeToolCall; delayMs: number } | null {
  if (last.includes('"tool_result"')) return null;
  if (tools.has("bash") && last.includes("RUN_BASH")) {
    return {
      call: { name: "bash", input: { command: "hostname" } },
      delayMs: 0,
    };
  }
  const status = ASYNC_STATUS_TRIGGER.exec(last);
  if (!tools.has("async_status") || !status?.[2]) return null;

  return {
    call: { name: "async_status", input: { statusId: status[2] } },
    delayMs: Number(status[1] ?? 0),
  };
}

/** A Messages API answer: text, or the one tool call a trigger asks for. */
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
  const tools = new Set(
    (request.tools ?? []).flatMap((tool): string[] =>
      tool.name ? [tool.name] : [],
    ),
  );
  // A message that already carries a delivered result asks for nothing: a
  // resume's text merges into the user message of a turn that died, which
  // still carries that turn's trigger.
  const last = JSON.stringify(request.messages.at(-1)?.content);
  const answer = toolCallFor(
    last.includes(DELIVERED_RESULT_MARKER) ? "" : last,
    tools,
  );
  const { block, delta, stopReason } = answer
    ? {
        block: {
          type: "tool_use",
          id: `toolu_${Date.now()}_${Math.random().toString(36).slice(2)}`,
          name: answer.call.name,
          input: {},
        },
        delta: {
          type: "input_json_delta",
          partial_json: JSON.stringify(answer.call.input),
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
  const headers = { "content-type": "text/event-stream" };
  if (!answer?.delayMs) {
    return new Response(frames.join(""), { status: 200, headers: headers });
  }
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start: async function (controller): Promise<void> {
      await Bun.sleep(answer.delayMs);
      controller.enqueue(encoder.encode(frames.join("")));
      controller.close();
    },
  });

  return new Response(body, { status: 200, headers: headers });
}
