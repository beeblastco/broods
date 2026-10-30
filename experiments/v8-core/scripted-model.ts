/**
 * A scripted stand-in for api.anthropic.com, loaded the same way into both
 * runtimes (Bun: --preload; workerd: imported by entry.ts when
 * BENCH_SCRIPTED_MODEL=1). It plays the complex task step by step, so both
 * runtimes make the exact same tool calls and timing differences belong to the
 * platform, not to the model. BENCH_MODEL_DELAY_MS adds a fixed wait per model
 * call to stand in for real model latency. Every call core makes to Convex is
 * printed as one BENCH_CONVEX line so calls per task can be counted, and every
 * model call as one BENCH_MODEL line naming the runtime that made it.
 */

const USAGE = { input_tokens: 100, output_tokens: 10 };
const CHILD_MARK = "primes.sh";
export const childPrompt = (dir: string): string =>
  `In bash, inside the folder ${dir}, write primes.sh that prints every prime below 30000 and run it, saving the list to primes.txt. Report how many primes there are and the largest one.`;
const primesCommand = (dir: string): string =>
  [
    `mkdir -p ${dir} && cat > ${dir}/primes.sh <<'SH'`,
    "awk 'BEGIN{n=30000; for(i=2;i<n;i++)s[i]=1; for(i=2;i*i<n;i++) if(s[i]) for(j=i*i;j<n;j+=i) s[j]=0; for(i=2;i<n;i++) if(s[i]) print i}'",
    "SH",
    `bash ${dir}/primes.sh > ${dir}/primes.txt; wc -l < ${dir}/primes.txt; tail -1 ${dir}/primes.txt`,
  ].join("\n");
const notesCommand = (dir: string): string =>
  `mkdir -p ${dir}/notes && printf 'Workers Paid CPU limit: 300000 ms\\n' > ${dir}/notes/limits.md && sha256sum ${dir}/notes/limits.md`;

interface Block {
  type: string;
  text?: string;
  name?: string;
  content?: string | Block[];
}
interface Message {
  role: string;
  content: string | Block[];
}
interface MessagesRequest {
  messages: Message[];
  model: string;
  stream?: boolean;
  tools?: { name?: string }[];
}

type Step =
  | { kind: "tool"; name: string; input: Record<string, unknown> }
  | { kind: "text"; text: string };

function blocks(message: Message | undefined): Block[] {
  if (!message) return [];

  return typeof message.content === "string"
    ? [{ type: "text", text: message.content }]
    : message.content;
}

/** The text of the last message: a tool result's output, or injected text. */
function lastText(request: MessagesRequest): string {
  return blocks(request.messages.at(-1))
    .map((b) =>
      b.type === "tool_result"
        ? typeof b.content === "string"
          ? b.content
          : (b.content ?? []).map((c) => c.text ?? "").join("")
        : (b.text ?? ""),
    )
    .join(" ")
    .replace(/\s+/g, " ")
    .slice(0, 400);
}

// Core hands a subagent's result back to the parent as a new user message
// that starts like this; the parent's earlier tool calls are compacted out of
// that follow-up turn.
const INJECTED_MARK = "Subagent and async agent result injected";

function nextStep(request: MessagesRequest): Step {
  const firstUser = JSON.stringify(
    request.messages.find((m) => m.role === "user")?.content ?? "",
  );
  const dir = /task-[a-z0-9-]+/.exec(firstUser)?.[0] ?? "task-unknown";
  // The turn starts at the last user message that carries text, not a tool result.
  const turnStart = request.messages.findLastIndex(
    (m) => m.role === "user" && blocks(m).some((b) => b.type === "text"),
  );
  const turnInput = JSON.stringify(request.messages[turnStart]?.content ?? "");
  const toolUses = request.messages
    .slice(turnStart + 1)
    .filter((m) => m.role === "assistant")
    .flatMap(blocks)
    .filter((b) => b.type === "tool_use").length;
  if (
    firstUser.includes(CHILD_MARK) &&
    !firstUser.includes("Do all of these")
  ) {
    return toolUses === 0
      ? { kind: "tool", name: "bash", input: { command: primesCommand(dir) } }
      : { kind: "text", text: `CHILD_RESULT ${lastText(request)}` };
  }
  if (turnInput.includes(INJECTED_MARK)) {
    const child =
      /CHILD_RESULT[^"\\]*/.exec(turnInput)?.[0] ??
      `no child result in: ${turnInput.slice(0, 300)}`;

    return { kind: "text", text: `PARENT_FOLLOWUP ${child}` };
  }
  const mcpTool = request.tools?.find((t) =>
    t.name?.startsWith("cfdocs__"),
  )?.name;
  if (toolUses === 0) {
    return mcpTool
      ? {
          kind: "tool",
          name: mcpTool,
          input: { query: "Workers CPU time limit paid plan" },
        }
      : { kind: "text", text: "SCRIPT ERROR: no cfdocs MCP tool was offered." };
  }
  if (toolUses === 1)
    return {
      kind: "tool",
      name: "bash",
      input: { command: notesCommand(dir) },
    };
  if (toolUses === 2) {
    return {
      kind: "tool",
      name: "run_subagent",
      input: { tasks: [{ prompt: childPrompt(dir) }] },
    };
  }

  return { kind: "text", text: `PARENT_STARTED ${lastText(request)}` };
}

function event(type: string, fields: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type: type, ...fields })}\n\n`;
}

async function scriptedModel(request: MessagesRequest): Promise<Response> {
  const delay = Number(process.env.BENCH_MODEL_DELAY_MS ?? 0);
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  if (process.env.BENCH_MODEL_DEBUG === "1") {
    console.log(
      `BENCH_DEBUG ${JSON.stringify(
        request.messages.map(
          (m) =>
            `${m.role}:${blocks(m)
              .map(
                (b) =>
                  `${b.type}${b.name ? `(${b.name})` : ""}${b.text ? `[${b.text.slice(0, 60)}]` : ""}`,
              )
              .join(",")}`,
        ),
      )}`,
    );
  }
  const step = nextStep(request);
  // One line per model call, so a bench can prove which runtime ran the work.
  console.log(
    `BENCH_MODEL ${process.env.SERVICE_NAME ?? "?"} ${step.kind === "tool" ? step.name : step.text.split(" ")[0]}`,
  );
  const message = {
    id: `msg_${crypto.randomUUID()}`,
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
  const { block, delta, stopReason } =
    step.kind === "tool"
      ? {
          block: {
            type: "tool_use",
            id: `toolu_${crypto.randomUUID().replaceAll("-", "")}`,
            name: step.name,
            input: {},
          },
          delta: {
            type: "input_json_delta",
            partial_json: JSON.stringify(step.input),
          },
          stopReason: "tool_use",
        }
      : {
          block: { type: "text", text: "" },
          delta: { type: "text_delta", text: step.text },
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
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: USAGE.output_tokens },
    }),
    event("message_stop", {}),
  ];

  return new Response(frames.join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

export function installScriptedModel(): void {
  const convexUrl = process.env.CONVEX_URL ?? "";
  const realFetch = globalThis.fetch;
  globalThis.fetch = async function fetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const url = input instanceof Request ? input.url : input.toString();
    if (new URL(url).hostname === "api.anthropic.com") {
      const body =
        typeof init?.body === "string"
          ? init.body
          : await new Request(input, init).text();

      return scriptedModel(JSON.parse(body) as MessagesRequest);
    }
    if (convexUrl && url.startsWith(convexUrl)) {
      const body = typeof init?.body === "string" ? init.body : "";
      console.log(
        `BENCH_CONVEX ${/"path":"([^"]+)"/.exec(body)?.[1] ?? new URL(url).pathname}`,
      );
    }

    return realFetch(input, init);
  } as typeof fetch;
}
