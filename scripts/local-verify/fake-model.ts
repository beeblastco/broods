// Core preload for `local-stack up --perf`: answers api.anthropic.com in process so perf
// times Broods, not the model, and traces core's Convex calls to BROODS_LOCAL_CONVEX_TRACE.

import { appendFileSync, existsSync, readFileSync } from "node:fs";

const CONVEX_URL = process.env.CONVEX_URL ?? "";
const TRACE_PATH = process.env.BROODS_LOCAL_CONVEX_TRACE ?? "";
const USAGE = { input_tokens: 100, output_tokens: 10 };
// `local-stack crash` holds the first write that would store such a result: a resume's save,
// a status read's step save (`read`), or the answer of a child that saves no history.
const HELD_RESULT = /async_tool_(resume|read|child)hold_[0-9a-f-]{36}/;
const DELIVERED = "CRASHPAYLOAD-";
// `ASYNC_STATUS:<ms>:<id>` reads a result after <ms>; `SUBAGENT:<agentId>:<prompt>` delegates.
const STATUS_READ = /ASYNC_STATUS:(\d+):(async_tool_[\w-]+)/;
const SUBAGENT_RUN = /SUBAGENT:([\w-]+):(ASYNC_STATUS:\d+:async_tool_[\w-]+)/;
const ANSWER_WRITES = new Set(["runtime:updateAsyncAgentResult"]);
const HISTORY_WRITES = new Set([
  "runtime:appendConversationEvent",
  "runtimeIngress:appendConversationEvent",
  "runtimeIngress:settle",
  "runtimeIngress:stepBoundary",
  "runtimeIngress:takeNext",
]);

export interface MessagesRequest {
  messages: { content: unknown }[];
  model: string;
  stream?: boolean;
  tools?: { name?: string }[];
}

const realFetch = globalThis.fetch;

// A workspace on a reserved sandbox (`crash`'s readers) reads its memory file at turn start:
// this S3 has none, so such a turn runs with no AWS. Only as the stack's preload: an importer
// would keep the listener open.
if (TRACE_PATH) {
  const emptyS3 = Bun.serve({
    port: 0,
    fetch: (): Response =>
      new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 }),
  });
  Object.assign(process.env, {
    AWS_ACCESS_KEY_ID: "local",
    AWS_ENDPOINT_URL_S3: emptyS3.url.href,
    AWS_REGION: "us-east-1",
    AWS_SECRET_ACCESS_KEY: "local",
    // Not DNS-safe, so the SDK addresses it by path on the local endpoint.
    FILESYSTEM_BUCKET_NAME: "broods_local",
  });
}

globalThis.fetch = Object.assign(
  async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = input instanceof Request ? input.url : input.toString();
    const body = typeof init?.body === "string" ? init.body : "";
    if (new URL(url).hostname === "api.anthropic.com") {
      const request = JSON.parse(body) as MessagesRequest;
      const last = lastContent(request);
      if (toolCall(last, toolNames(request))?.name === "async_status") {
        await Bun.sleep(Number(STATUS_READ.exec(last)?.[1]));
      }

      return fakeModel(request);
    }
    if (TRACE_PATH && CONVEX_URL && url.startsWith(CONVEX_URL)) {
      const fn = /"path":"([^"]+)"/.exec(body)?.[1] ?? new URL(url).pathname;
      appendFileSync(
        TRACE_PATH,
        `${JSON.stringify({ at: Date.now(), fn: fn })}\n`,
      );
      if (holds(fn, body)) return new Promise<Response>((): void => {});
    }

    return realFetch(input, init);
  },
  { preconnect: realFetch.preconnect },
);

// Each result once, across restarts, and none once `<trace>.hold-off` exists.
function holds(fn: string, body: string): boolean {
  const [id, kind] = HELD_RESULT.exec(body) ?? [];
  const ledger = `${TRACE_PATH}.held`;
  const writes = kind === "child" ? ANSWER_WRITES : HISTORY_WRITES;
  if (
    !id ||
    !writes.has(fn) ||
    (kind === "read" && !body.includes('"tool-result"')) ||
    existsSync(`${TRACE_PATH}.hold-off`)
  )
    return false;
  if (existsSync(ledger) && readFileSync(ledger, "utf8").includes(id))
    return false;
  appendFileSync(ledger, `${id}\n`);

  return true;
}

function event(type: string, fields: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type: type, ...fields })}\n\n`;
}

// `inputTokens` lets a caller report a near-full context, which makes a harness compact.
export function fakeModel(
  request: MessagesRequest,
  inputTokens: number = USAGE.input_tokens,
): Response {
  const usage = { ...USAGE, input_tokens: inputTokens };
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
      usage: usage,
    });
  }
  const last = lastContent(request);
  const call = toolCall(last, toolNames(request));
  // An answer after a status read names the result, so the write that hands it on carries it.
  const text = last.includes('"tool_result"')
    ? (HELD_RESULT.exec(last)?.[0] ?? "OK")
    : "OK";
  const { block, delta, stopReason } = call
    ? {
        block: {
          type: "tool_use",
          id: `toolu_${Date.now()}`,
          name: call.name,
          input: {},
        },
        delta: {
          type: "input_json_delta",
          partial_json: JSON.stringify(call.input),
        },
        stopReason: "tool_use",
      }
    : {
        block: { type: "text", text: "" },
        delta: { type: "text_delta", text: text },
        stopReason: "end_turn",
      };
  const frames = [
    event("message_start", {
      message: { ...message, content: [], stop_reason: null, usage: usage },
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

function toolNames(request: MessagesRequest): Set<string | undefined> {
  return new Set(request.tools?.map((tool) => tool.name));
}

function lastContent(request: MessagesRequest): string {
  return JSON.stringify(request.messages.at(-1)?.content);
}

// A resume merges into the user message of a turn that died, so a delivered result asks nothing.
function toolCall(
  last: string,
  tools: Set<string | undefined>,
): { name: string; input: unknown } | undefined {
  if (last.includes('"tool_result"') || last.includes(DELIVERED))
    return undefined;
  const delegate = SUBAGENT_RUN.exec(last);
  if (tools.has("run_subagent") && delegate) {
    return {
      name: "run_subagent",
      input: { tasks: [{ agentId: delegate[1], prompt: delegate[2] }] },
    };
  }
  const read = STATUS_READ.exec(last);
  if (tools.has("async_status") && read) {
    return { name: "async_status", input: { statusId: read[2] } };
  }
  if (tools.has("bash") && last.includes("RUN_BASH")) {
    return { name: "bash", input: { command: "hostname" } };
  }

  return undefined;
}
