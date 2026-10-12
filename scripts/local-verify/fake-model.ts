/**
 * Core preload for `local-stack up --perf`. Answers api.openai.com in
 * process, so a perf run times Broods and not the model, and appends every
 * core call to the local Convex backend to BROODS_LOCAL_CONVEX_TRACE so
 * `local-stack perf` can count round trips per turn. Never loaded outside the
 * local stack.
 */

import { appendFileSync } from "node:fs";

const CONVEX_URL = process.env.CONVEX_URL ?? "";
const TRACE_PATH = process.env.BROODS_LOCAL_CONVEX_TRACE ?? "";
const MODEL = "gpt-6-luna";
const USAGE = { input_tokens: 100, output_tokens: 10, total_tokens: 110 };

interface ResponsesRequest {
  input: { content?: unknown; role?: string }[];
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
    if (new URL(url).hostname === "api.openai.com") {
      return fakeModel(JSON.parse(body) as ResponsesRequest);
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

/** A Responses API answer: text, or one `bash` call when the user asks with RUN_BASH. */
function fakeModel(request: ResponsesRequest): Response {
  const last = request.input.at(-1);
  const wantsBash =
    last?.role === "user" &&
    JSON.stringify(last.content).includes("RUN_BASH") &&
    request.tools?.some((tool) => tool.name === "bash") === true;
  const response = { id: `resp_${Date.now()}`, created_at: 0, model: MODEL };
  if (!request.stream) {
    return Response.json({
      ...response,
      object: "response",
      status: "completed",
      output: [
        {
          type: "message",
          id: "msg_local",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "Summary.", annotations: [] }],
        },
      ],
      usage: USAGE,
    });
  }
  const item = wantsBash
    ? {
        type: "function_call",
        id: "fc_local",
        call_id: `call_${Date.now()}`,
        name: "bash",
        arguments: JSON.stringify({ command: "hostname" }),
        status: "completed",
      }
    : { type: "message", id: "msg_local", role: "assistant" };
  const frames = [
    event("response.created", { response: response }),
    event("response.output_item.added", { output_index: 0, item: item }),
    ...(wantsBash
      ? []
      : [
          event("response.output_text.delta", {
            item_id: item.id,
            output_index: 0,
            delta: "OK",
          }),
        ]),
    event("response.output_item.done", { output_index: 0, item: item }),
    event("response.completed", { response: { ...response, usage: USAGE } }),
  ];

  return new Response(frames.join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}
