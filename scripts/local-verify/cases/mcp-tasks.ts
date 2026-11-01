import type { AsyncStatus } from "../../../packages/broods/src/types.ts";
import {
  MODEL_KEY_HINT,
  OK_AGENT,
  assertStep,
  connectMachine,
  pollUntil,
  type VerifyContext,
} from "../harness.ts";

const PROTOCOL_VERSION = "2026-07-28";
const QUESTION_ID = "color";
const ANSWER = "Blue";
const TASKS_EXTENSION = "io.modelcontextprotocol/tasks";
const TASKS = { extensions: { [TASKS_EXTENSION]: {} } };
const TERMINAL = new Set(["completed", "cancelled", "failed"]);
const POLL = {
  initialIntervalMs: 200,
  maxIntervalMs: 2_000,
  timeoutMs: 120_000,
};

interface McpResponse {
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

interface Task {
  taskId: string;
  status: string;
  createdAt: string;
  lastUpdatedAt: string;
  inputRequests?: Record<string, unknown>;
  result?: { content: { type: string; text: string }[]; isError?: boolean };
}

/**
 * Broods as an MCP Tasks server at `/mcp`, through the edge: discovery, the
 * account's agents as tools, a tool call that answers a task, polling it to
 * the end, and cancel. With a model key, also a question answered through
 * `tasks/update` and a live run cancelled at its next step.
 */
export async function mcpTasks(context: VerifyContext): Promise<void> {
  const key = `mcp-tasks-${context.runId}`;
  const discovered = await mcp(context, "server/discover", {});
  assertStep(
    "/mcp advertises the tasks extension",
    JSON.stringify(discovered.result?.capabilities ?? {}).includes(
      TASKS_EXTENSION,
    ),
    JSON.stringify(discovered),
  );

  const { agentId } = await context.account.createAgent({
    name: key,
    description: "Says OK.",
    config: { ...context.model, agent: OK_AGENT },
  });
  const listed = await mcp(context, "tools/list", {});
  const tools = (listed.result?.tools ?? []) as {
    name: string;
    title?: string;
  }[];
  assertStep(
    "tools/list names the agent by id with its name as title",
    tools.some((tool) => tool.name === agentId && tool.title === key),
    JSON.stringify(tools.map((tool) => tool.name)),
  );

  const refused = await mcp(
    context,
    "tools/call",
    { name: agentId, arguments: { prompt: "Say OK." } },
    { capabilities: {} },
  );
  assertStep(
    "a client without the tasks extension gets -32021",
    refused.error?.code === -32021,
    JSON.stringify(refused),
  );

  const task = await callTool(context, agentId, "Say OK.");
  assertStep(
    "tools/call answers a task named by its run id",
    /^run_[0-9a-f]{32}$/.test(task.taskId),
    JSON.stringify(task),
  );
  const run = await context.client.getAsyncStatus(task.taskId);
  assertStep(
    "the run carries createdAt and lastUpdatedAt",
    run.createdAt === task.createdAt && typeof run.lastUpdatedAt === "string",
    JSON.stringify(run),
  );

  const done = await context.measure(
    "task polled to the end",
    (): Promise<Task | null> => pollTask(context, task.taskId, TERMINAL),
  );
  assertStep(
    context.hasModelKey
      ? "the task completed with the agent's answer"
      : `the task completed with the run's error (${MODEL_KEY_HINT})`,
    done?.status === "completed" &&
      done.result?.isError === !context.hasModelKey &&
      (!context.hasModelKey || /OK/.test(done.result?.content[0]?.text ?? "")),
    JSON.stringify(done),
  );

  const unknown = await mcp(context, "tasks/get", { taskId: "run_unknown" });
  assertStep(
    "an unknown task is invalid params",
    unknown.error?.code === -32602,
    JSON.stringify(unknown),
  );

  const toCancel = await callTool(context, agentId, "Say OK.");
  const cancelled = await mcp(context, "tasks/cancel", {
    taskId: toCancel.taskId,
  });
  const settled = await pollTask(context, toCancel.taskId, TERMINAL);
  assertStep(
    "tasks/cancel acks and the task still settles",
    cancelled.result?.resultType === "complete" && settled !== null,
    JSON.stringify({ cancelled: cancelled, settled: settled }),
  );

  if (!context.hasModelKey) {
    console.log(`  skip MCP question and live cancel (${MODEL_KEY_HINT})`);
    return;
  }
  await questionRoundTrip(context, key);
  await liveCancel(context, key);
}

async function callTool(
  context: VerifyContext,
  agentId: string,
  prompt: string,
): Promise<Task> {
  const called = await mcp(context, "tools/call", {
    name: agentId,
    arguments: { prompt: prompt },
  });
  assertStep(
    "tools/call returned a task",
    called.result?.resultType === "task",
    JSON.stringify(called),
  );

  return called.result as unknown as Task;
}

/** A run stopped by tasks/cancel while it works ends cancelled. */
async function liveCancel(context: VerifyContext, key: string): Promise<void> {
  const machine = await connectMachine(context, {
    computer: false,
    name: `${key}-cancel`,
    timeout: 5,
  });
  try {
    const { agentId } = await context.account.createAgent({
      name: `${key}-cancel`,
      config: {
        ...context.model,
        agent: {
          system:
            "Use the bash tool to run `sleep 3`, ten times, one call per step. Then reply DONE.",
        },
        sandboxes: [machine.sandboxId],
      },
    });
    const task = await callTool(context, agentId, "Start.");
    await pollUntil(POLL, async (): Promise<AsyncStatus | null> => {
      const run = await context.client.getAsyncStatus(task.taskId);

      return run.status === "processing" ? run : null;
    });
    await mcp(context, "tasks/cancel", { taskId: task.taskId });
    const done = await pollTask(context, task.taskId, TERMINAL);
    assertStep(
      "a live task cancelled at its next step is cancelled",
      done?.status === "cancelled",
      JSON.stringify(done),
    );
  } finally {
    await machine.stop();
  }
}

async function mcp(
  context: VerifyContext,
  method: string,
  params: Record<string, unknown>,
  options: { capabilities?: object } = {},
): Promise<McpResponse> {
  const name = params.taskId ?? params.name;
  const response = await fetch(`${context.edgeUrl}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${context.accountSecret}`,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "MCP-Protocol-Version": PROTOCOL_VERSION,
      "Mcp-Method": method,
      ...(typeof name === "string" ? { "Mcp-Name": name } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
          "io.modelcontextprotocol/clientInfo": {
            name: "local-verify",
            version: "1",
          },
          "io.modelcontextprotocol/clientCapabilities":
            options.capabilities ?? TASKS,
        },
      },
    }),
    signal: AbortSignal.timeout(30_000),
  });

  return (await response.json()) as McpResponse;
}

async function pollTask(
  context: VerifyContext,
  taskId: string,
  until: ReadonlySet<string>,
): Promise<Task | null> {
  return pollUntil(POLL, async (): Promise<Task | null> => {
    const got = await mcp(context, "tasks/get", { taskId: taskId });
    const task = got.result as unknown as Task | undefined;

    return task && until.has(task.status) ? task : null;
  });
}

/** An ask_questions prompt surfaces as a form; its answer resumes the same task. */
async function questionRoundTrip(
  context: VerifyContext,
  key: string,
): Promise<void> {
  const { agentId } = await context.account.createAgent({
    name: `${key}-ask`,
    config: {
      ...context.model,
      agent: {
        system: `On the first user message call ask_questions exactly once, with blocking true and one question: id "${QUESTION_ID}", header "Color", question "Which color?", options "Red" and "Blue". Then end your turn with no other tool call. When the answer arrives, reply with exactly the chosen color and nothing else.`,
      },
    },
  });
  const task = await callTool(context, agentId, "Pick a color for me.");
  const asked = await pollTask(
    context,
    task.taskId,
    new Set([...TERMINAL, "input_required"]),
  );
  const requestKey = Object.keys(asked?.inputRequests ?? {})[0];
  if (asked?.status !== "input_required" || requestKey === undefined) {
    console.log(
      `  skip MCP question round trip (the agent asked nothing: ${JSON.stringify(asked)})`,
    );
    return;
  }
  assertStep(
    "the open question is one elicitation form",
    requestKey.startsWith("question-") &&
      JSON.stringify(asked.inputRequests).includes(`"enum":["Red","Blue"]`),
    JSON.stringify(asked.inputRequests),
  );

  await mcp(context, "tasks/update", {
    taskId: task.taskId,
    inputResponses: {
      [requestKey]: { action: "accept", content: { [QUESTION_ID]: ANSWER } },
    },
  });
  const answered = await pollTask(context, task.taskId, TERMINAL);
  assertStep(
    "the answered task completes with the chosen option",
    answered?.status === "completed" &&
      (answered.result?.content[0]?.text ?? "").includes(ANSWER),
    JSON.stringify(answered),
  );
}
