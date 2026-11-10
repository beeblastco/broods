/**
 * `/mcp`: `list_agents` names the agents a caller can run and `ask_agent` runs one. A client
 * with the tasks extension gets a task whose id is the run id; any other client gets the answer
 * directly. Holds no state: every read and write goes through core's own `/v1/runs` routes.
 */
import {
  CallToolResultV2Schema,
  CreateTaskResultV2Schema,
  ElicitResultV2Schema,
  GetTaskRequestV2Schema,
  hasTaskClientCapabilityV2,
  TASKS_EXTENSION_ID_V2,
  type CallToolResultV2,
  type CreateTaskResultV2,
  type DetailedTaskV2,
  type ElicitRequestV2,
  type ElicitResultV2,
  type ToolV2,
} from "@modelcontextprotocol/ext-tasks/core/v2";
import {
  createMcpHandler,
  MissingRequiredClientCapabilityError,
  ProtocolError,
  ProtocolErrorCode,
  Server,
  type ServerContext,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import type { ApiErrorBody } from "@broods/convex/model/apiError";
import type {
  AsyncRequestAccepted,
  AsyncStatus,
  ToolApprovalSummary,
} from "../../../../packages/broods/src/types.ts";
import type { PendingQuestion } from "../../../../packages/broods/src/websocket-contracts.ts";
import {
  extractBearerToken,
  resolveBearerAuth,
  type AuthContext,
} from "../shared/auth.ts";
import { runtime } from "../shared/convex/runtime.ts";
import type { AgentRecord } from "../shared/domain/agents.ts";
import { errorResponse, type CoreRequest } from "../shared/http.ts";
import { getStorage } from "../shared/storage.ts";
import {
  scopedDirectConversationKey,
  scopedDirectEventId,
} from "../shared/runtime-keys.ts";
import { asyncToolContinuationEventId } from "./async-tool-result.ts";
import { getIngressStatusByEventId } from "./ingress.ts";
import { listRunnableAgents } from "./integrations.ts";
import {
  MCP_PATH,
  mcpUnauthorized,
  resolveAuthKitAuth,
} from "./mcp/authkit.ts";

const ASK_ARGS = z.object({
  agent: z.string().trim().min(1),
  prompt: z.string().trim().min(1),
  conversationId: z.string().trim().min(1).optional(),
});
const ASK_TOOL = "ask_agent";
const ASK_TOOL_DEFINITION: ToolV2 = {
  name: ASK_TOOL,
  description:
    "Ask one Broods agent and get its answer. Find the agents with list_agents.",
  inputSchema: {
    type: "object",
    properties: {
      agent: {
        type: "string",
        description:
          "The agent's name or id from list_agents. Use the id when a name appears twice.",
      },
      prompt: {
        type: "string",
        description:
          "The full request. The agent cannot see your conversation, so include what it needs.",
      },
      conversationId: {
        type: "string",
        description:
          "From an earlier answer, to continue that conversation. Omit to start a new one.",
      },
    },
    required: ["agent", "prompt"],
  },
};
const APPROVAL_KEY_PREFIX = "approval-";
// An approval reply's event id is the waiting run's plus this, so a task can
// find the reply that carries it on without storing anything.
const APPROVAL_EVENT_SUFFIX = ":approval";
const DECLINED_ANSWER = "The user declined to answer.";
const CONTINUE_ARGS = z.object({
  runId: z.string().min(1),
  answers: z.record(z.string(), z.string()).optional(),
});
const CONTINUE_TOOL = "continue_run";
const CONTINUE_TOOL_DEFINITION: ToolV2 = {
  name: CONTINUE_TOOL,
  description:
    "Get the answer of a run that was still working, or answer the questions it asked. Waits up to 50 seconds.",
  inputSchema: {
    type: "object",
    properties: {
      runId: { type: "string", description: "The runId you were given." },
      answers: {
        type: "object",
        description: "Question id to answer. Pick an option or write your own.",
        additionalProperties: { type: "string" },
      },
    },
    required: ["runId"],
  },
};
const FINISHED_STATUSES: ReadonlySet<RunStatus["status"]> = new Set([
  "completed",
  "failed",
  "expired",
]);
const GET_RUN_TOOL = "get_run";
const GET_RUN_TOOL_DEFINITION: ToolV2 = {
  name: GET_RUN_TOOL,
  description:
    "Read a run without waiting: its answer if it finished, what it asked if it is waiting, or that it is still working.",
  inputSchema: {
    type: "object",
    properties: {
      runId: { type: "string", description: "The runId you were given." },
    },
    required: ["runId"],
  },
};
const LIST_ARGS = z.object({
  project: z.string().trim().min(1).optional(),
  stage: z.string().trim().min(1).optional(),
});
const LIST_TOOL = "list_agents";
const LIST_TOOL_DEFINITION: ToolV2 = {
  name: LIST_TOOL,
  description:
    "List the Broods agents you can ask: each one's name, what it does, its project and stage, and its id. Call this first to pick an agent for ask_agent.",
  inputSchema: {
    type: "object",
    properties: {
      project: { type: "string", description: "Only this project's agents." },
      stage: { type: "string", description: "Only agents in this stage." },
    },
  },
};
const MAX_APPROVAL_INPUT_CHARS = 300;
const POLL_INTERVAL_MS = 2_000;
const QUESTION_KEY_PREFIX = "question-";
const RUN_ARGS = z.object({ runId: z.string().min(1) });
const RUN_PATH = "/v1/runs";
// Prefixes the event id and conversation key of every run a task starts.
const RUN_PREFIX = "mcp-";
const SERVER_INFO = { name: "broods", version: "1.0.0" };
// Under the 60 second default request timeout most MCP clients apply.
const SYNC_WAIT_MS = 50_000;
const SYNC_FIRST_POLL_MS = 250;
const TASK_CAPABILITY = { extensions: { [TASKS_EXTENSION_ID_V2]: {} } };
const TASK_PARAMS = GetTaskRequestV2Schema.shape.params;
const TOOL_CALL_PARAMS = z.object({
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()).default({}),
});
const TOOL_CALL_RESULT = z.union([
  CreateTaskResultV2Schema,
  CallToolResultV2Schema,
]);

/** Core's own request handler, which every run read and write replays through. */
type McpReplay = (request: CoreRequest, auth: McpAuth) => Promise<Response>;

/** A run as `GET /v1/runs/{runId}` answers it; core sets every field named here. */
export type RunStatus = AsyncStatus &
  Required<
    Pick<
      AsyncStatus,
      | "agentId"
      | "conversationKey"
      | "createdAt"
      | "eventId"
      | "lastUpdatedAt"
      | "runId"
    >
  >;

/** A task's first run, and the approval reply it now waits on (itself when none). */
interface TaskRuns {
  root: RunStatus;
  current: RunStatus;
}

// Every credential but the admin secret names an account.
type McpAuth = Exclude<AuthContext, { kind: "admin" }>;

interface McpCaller {
  auth: McpAuth;
  request: CoreRequest;
  replay: (request: CoreRequest) => Promise<Response>;
}

/** Serves one `/mcp` request. Only 2026-07-28 traffic is served. */
export async function handleMcpRequest(
  request: CoreRequest,
  replay: McpReplay,
): Promise<Response> {
  const auth = await mcpAuth(request);
  if (auth instanceof Response) return auth;
  const caller: McpCaller = {
    auth: auth,
    request: request,
    replay: (replayed): Promise<Response> => replay(replayed, auth),
  };
  const mcp = createMcpHandler((): Server => createTaskServer(caller), {
    legacy: "reject",
  });

  return mcp.fetch(
    new Request(`http://core${MCP_PATH}`, {
      method: request.method,
      headers: request.headers,
      body:
        request.method === "GET" || request.method === "HEAD"
          ? null
          : request.body,
    }),
  );
}

/**
 * The task a run chain stands at. A failed tool is `completed` with
 * `isError`: `failed` is for JSON-RPC errors only, and a run never raises one.
 */
export function taskFromRuns(runs: TaskRuns): DetailedTaskV2 {
  const { root, current } = runs;
  const base = {
    taskId: root.runId,
    createdAt: root.createdAt,
    lastUpdatedAt: current.lastUpdatedAt,
    ttlMs: null,
    pollIntervalMs: POLL_INTERVAL_MS,
  };
  switch (current.status) {
    case "awaiting_input":
    case "awaiting_approval":
      return {
        ...base,
        status: "input_required",
        inputRequests: Object.fromEntries([
          ...(current.questions ?? []).map((prompt) => [
            `${QUESTION_KEY_PREFIX}${prompt.statusId}`,
            questionRequest(prompt),
          ]),
          ...(current.approvals?.length
            ? [
                [
                  `${APPROVAL_KEY_PREFIX}${current.runId}`,
                  approvalRequest(current.approvals),
                ],
              ]
            : []),
        ]),
      };
    case "completed":
      // An answered question's continuation that fails settles the row
      // completed with only an error.
      if (current.response === undefined && current.error) {
        return failedTask(base, current.error);
      }

      return {
        ...base,
        status: "completed",
        result: answerResult(current, root.conversationKey),
      };
    case "failed":
      if (current.stoppedByUser) {
        return { ...base, status: "cancelled" };
      }

      return failedTask(base, current.error ?? "The run failed.");
    case "expired":
      return failedTask(base, "The run expired before it finished.");
    default:
      return { ...base, status: "working" };
  }
}

function createTaskServer(caller: McpCaller): Server {
  const server = new Server(SERVER_INFO, {
    capabilities: { tools: {}, ...TASK_CAPABILITY },
  });
  server.setRequestHandler(
    "tools/list",
    async (_params, ctx): Promise<{ tools: ToolV2[] }> => ({
      tools: [
        LIST_TOOL_DEFINITION,
        ASK_TOOL_DEFINITION,
        // A client with tasks reads and answers a run through `tasks/*` instead.
        ...(declaresTasks(ctx)
          ? []
          : [GET_RUN_TOOL_DEFINITION, CONTINUE_TOOL_DEFINITION]),
      ],
    }),
  );
  server.setRequestHandler(
    "tools/call",
    { params: TOOL_CALL_PARAMS, result: TOOL_CALL_RESULT },
    async (params, ctx): Promise<CreateTaskResultV2 | CallToolResultV2> => {
      const direct = !declaresTasks(ctx);
      const { signal } = ctx.mcpReq;
      if (params.name === LIST_TOOL) {
        return await listAgents(caller, params.arguments);
      }
      if (direct && params.name === CONTINUE_TOOL) {
        return await continueRun(caller, params.arguments, signal);
      }
      if (direct && params.name === GET_RUN_TOOL) {
        return await getRun(caller, params.arguments);
      }
      if (params.name !== ASK_TOOL) {
        throw new ProtocolError(
          ProtocolErrorCode.InvalidParams,
          `No tool named ${params.name}. Call ${LIST_TOOL} to see the agents, then ${ASK_TOOL} to run one.`,
        );
      }
      const input = ASK_ARGS.safeParse(params.arguments);
      if (!input.success) return toolResult(z.prettifyError(input.error), true);
      const agent = await findAgent(
        await listRunnableAgents(caller.auth),
        input.data.agent,
      );
      if (typeof agent === "string") return toolResult(agent, true);
      const runId = await startRun(caller, agent.agentId, input.data);
      if (typeof runId !== "string") return runId;

      return direct
        ? await waitForRun(caller, runId, signal)
        : await startedTask(caller, runId);
    },
  );
  server.setRequestHandler(
    "tasks/get",
    { params: TASK_PARAMS },
    async (
      params,
      ctx,
    ): Promise<DetailedTaskV2 & { resultType: "complete" }> => {
      requireTaskCapability(ctx);

      return {
        ...taskFromRuns(await resolveTask(caller, params.taskId)),
        resultType: "complete",
      };
    },
  );
  // The SDK lifts `inputResponses` off the params, and turns a non-map into `{}`.
  server.setRequestHandler(
    "tasks/update",
    { params: TASK_PARAMS },
    async (params, ctx): Promise<{ resultType: "complete" }> => {
      requireTaskCapability(ctx);
      const responses = ctx.mcpReq.inputResponses;
      if (
        !responses ||
        Object.keys(responses).length === 0 ||
        ctx.mcpReq.droppedInputResponseKeys !== undefined
      ) {
        throw new ProtocolError(
          ProtocolErrorCode.InvalidParams,
          "tasks/update needs an inputResponses map of bare responses",
        );
      }
      await updateTask(caller, params.taskId, responses);

      return { resultType: "complete" };
    },
  );
  server.setRequestHandler(
    "tasks/cancel",
    { params: TASK_PARAMS },
    async (params, ctx): Promise<{ resultType: "complete" }> => {
      requireTaskCapability(ctx);
      await cancelTask(caller, params.taskId);

      return { resultType: "complete" };
    },
  );

  return server;
}

function answerResult(
  run: RunStatus,
  conversationKey: string,
): CallToolResultV2 {
  const answer =
    run.response === undefined
      ? ""
      : typeof run.response === "string"
        ? run.response
        : JSON.stringify(run.response);

  return {
    ...toolResult(answer, false),
    content: [
      { type: "text", text: answer },
      {
        type: "text",
        text: `[conversationId: ${conversationKey}. Pass it back to continue this conversation.]`,
      },
    ],
  };
}

/**
 * The run's one approval form, answered whole: one reply carries every
 * decision, and its event id can be sent once.
 */
async function answerApprovals(
  caller: McpCaller,
  run: RunStatus,
  responses: Record<string, unknown>,
): Promise<void> {
  const decision = ElicitResultV2Schema.safeParse(
    responses[`${APPROVAL_KEY_PREFIX}${run.runId}`],
  ).data;
  if (!decision) return;
  const parts = (run.approvals ?? []).map((approval) => ({
    type: "tool-approval-response",
    approvalId: approval.approvalId,
    approved:
      decision.action === "accept" &&
      decision.content?.[approval.approvalId] === true,
  }));
  await sendRunRequest(
    caller,
    {
      agentId: run.agentId,
      conversationKey: run.conversationKey,
      eventId: `${run.eventId}${APPROVAL_EVENT_SUFFIX}`,
      background: true,
      events: [{ role: "tool", content: parts }],
    },
    false,
  );
}

/** Each answered prompt settles through `answers`; the run's own row carries on. */
async function answerQuestions(
  caller: McpCaller,
  run: RunStatus,
  responses: Record<string, unknown>,
): Promise<void> {
  const answers = (run.questions ?? []).flatMap((prompt) => {
    const response = ElicitResultV2Schema.safeParse(
      responses[`${QUESTION_KEY_PREFIX}${prompt.statusId}`],
    ).data;

    return response
      ? [
          {
            statusId: prompt.statusId,
            answers: promptAnswers(prompt, response),
          },
        ]
      : [];
  });
  if (answers.length === 0) return;
  await sendRunRequest(
    caller,
    {
      agentId: run.agentId,
      conversationKey: run.conversationKey,
      eventId: `${RUN_PREFIX}${crypto.randomUUID()}`,
      answers: answers,
    },
    true,
  );
}

/**
 * The run that carries a waiting one on once its input arrived: the approval
 * reply, or the continuation core starts for an answered question.
 */
async function nextRun(
  caller: McpCaller,
  waiting: RunStatus,
): Promise<RunStatus | null> {
  const accountId = caller.auth.account.accountId;
  const eventIds =
    waiting.status === "awaiting_approval"
      ? [`${waiting.eventId}${APPROVAL_EVENT_SUFFIX}`]
      : (waiting.questions ?? []).map((prompt) =>
          asyncToolContinuationEventId({
            parentEventId: waiting.eventId,
            resultId: prompt.statusId,
          }),
        );
  for (const eventId of eventIds) {
    const next = await getIngressStatusByEventId({
      accountId: accountId,
      agentId: waiting.agentId,
      eventId: scopedDirectEventId(accountId, waiting.agentId, eventId),
    });
    if (next?.runId) return readRun(caller, next.runId);
  }

  return null;
}

/** Every tool call waiting on approval as one checkbox of a single form. */
function approvalRequest(approvals: ToolApprovalSummary[]): ElicitRequestV2 {
  return {
    method: "elicitation/create",
    params: {
      mode: "form",
      message: "The agent wants to run these tools.",
      requestedSchema: {
        type: "object",
        properties: Object.fromEntries(
          approvals.map((approval) => [
            approval.approvalId,
            {
              type: "boolean",
              title: `Allow ${approval.toolName}?`,
              description: JSON.stringify(approval.input),
            },
          ]),
        ),
        required: approvals.map((approval) => approval.approvalId),
      },
    },
  };
}

/**
 * Stops the task's run at its next model step, like `/stop`. Only a key that
 * may start runs may stop one. A task waiting on input or queued behind
 * another run owns no live turn, so it stays where it is: the fence on its
 * event id keeps the stop off whichever run owns the conversation.
 */
async function cancelTask(caller: McpCaller, taskId: string): Promise<void> {
  const { auth } = caller;
  if (auth.kind !== "account" && auth.kind !== "deployment") {
    throw unknownTask(taskId);
  }
  const { root, current } = await resolveTask(caller, taskId);
  if (FINISHED_STATUSES.has(current.status)) return;
  await runtime.mutate("stopIngressOwner", {
    accountId: auth.account.accountId,
    agentId: root.agentId,
    conversationKey: scopedDirectConversationKey(
      auth.account.accountId,
      root.agentId,
      root.conversationKey,
    ),
    expectedOwnerEventId: scopedDirectEventId(
      auth.account.accountId,
      current.agentId,
      current.eventId,
    ),
  });
}

async function continueRun(
  caller: McpCaller,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<CallToolResultV2> {
  const input = CONTINUE_ARGS.safeParse(args);
  if (!input.success) return toolResult(z.prettifyError(input.error), true);
  const { runId, answers = {} } = input.data;
  try {
    const { current } = await resolveTask(caller, runId);
    const answering = (current.questions ?? []).filter((prompt) =>
      prompt.questions.some(({ id }) => id in answers),
    );
    const missing = answering.flatMap((prompt) =>
      prompt.questions.filter(({ id }) => !(id in answers)).map(({ id }) => id),
    );
    if (missing.length > 0) {
      return toolResult(
        `Answer these questions too: ${missing.join(", ")}`,
        true,
      );
    }
    const responses = Object.fromEntries(
      answering.map((prompt) => [
        `${QUESTION_KEY_PREFIX}${prompt.statusId}`,
        { action: "accept", content: answers },
      ]),
    );
    if (Object.keys(responses).length === 0) {
      return await waitForRun(caller, runId, signal);
    }
    await answerQuestions(caller, current, responses);

    return await waitForRun(caller, runId, signal, current.runId);
  } catch (error) {
    return protocolErrorResult(error);
  }
}

function declaresTasks(ctx: ServerContext): boolean {
  return hasTaskClientCapabilityV2({ _meta: ctx.mcpReq.envelope });
}

/** What a client without tasks reads for a run that has not produced its answer. */
function directReply(runs: TaskRuns): CallToolResultV2 {
  const { root, current } = runs;
  const task = taskFromRuns(runs);
  if (task.status === "completed") {
    return task.statusMessage === undefined
      ? answerResult(current, root.conversationKey)
      : toolResult(task.statusMessage, true);
  }
  if (task.status === "cancelled") {
    return toolResult("The run was cancelled.", true);
  }
  if (task.status !== "input_required") return stillWorking(root.runId);
  const questions = (current.questions ?? []).flatMap((prompt) =>
    prompt.questions.map(
      ({ id, options, question }) =>
        `- ${id}: ${question} Options: ${options.map(({ label }) => label).join(", ")}`,
    ),
  );
  const approvals = (current.approvals ?? []).map(
    ({ input, toolName }) =>
      `- ${toolName} ${JSON.stringify(input).slice(0, MAX_APPROVAL_INPUT_CHARS)}`,
  );

  return toolResult(
    [
      ...(questions.length > 0
        ? [
            "The agent asked:",
            ...questions,
            `Call ${CONTINUE_TOOL} with runId "${root.runId}" and answers, a map of question id to answer.`,
          ]
        : []),
      ...(approvals.length > 0
        ? [
            "The agent needs a person to approve these tool calls, and you cannot approve them:",
            ...approvals,
            "Tell the user. The run waits until someone approves it from a client with MCP tasks or POST /v1/runs.",
          ]
        : []),
    ].join("\n"),
    false,
  );
}

async function errorText(response: Response): Promise<string> {
  const body = (await response
    .json()
    .catch((): Partial<ApiErrorBody> => ({}))) as Partial<ApiErrorBody>;

  return body.error?.message ?? `The run request failed (${response.status}).`;
}

function failedTask(
  base: Omit<DetailedTaskV2, "status">,
  error: string,
): DetailedTaskV2 {
  return {
    ...base,
    status: "completed",
    statusMessage: error,
    result: toolResult(error, true),
  };
}

/** The agent a name or id picks, or what to tell the caller when it picks none or several. */
async function findAgent(
  agents: AgentRecord[],
  wanted: string,
): Promise<AgentRecord | string> {
  const named = agents.filter(
    ({ name }) => name.toLowerCase() === wanted.toLowerCase(),
  );
  const agent =
    agents.find(({ agentId }) => agentId === wanted) ??
    (named.length === 1 ? named[0] : undefined);
  if (agent) return agent;
  if (named.length === 0) {
    return `No agent named ${wanted}. Call ${LIST_TOOL} to see the agents you can ask.`;
  }
  const scopes = await getStorage().agents.scopes(named);
  const choices = named.map(({ agentId }) => {
    const scope = scopes.get(agentId);

    return scope
      ? `${agentId} (project ${scope.project}, stage ${scope.stage})`
      : agentId;
  });

  return `${named.length} agents are named ${wanted}. Pass one of these ids as agent: ${choices.join(", ")}.`;
}

/** `get_run`: where a run stands now, without waiting for it. */
async function getRun(
  caller: McpCaller,
  args: Record<string, unknown>,
): Promise<CallToolResultV2> {
  const input = RUN_ARGS.safeParse(args);
  if (!input.success) return toolResult(z.prettifyError(input.error), true);
  try {
    return directReply(await resolveTask(caller, input.data.runId));
  } catch (error) {
    return protocolErrorResult(error);
  }
}

async function listAgents(
  caller: McpCaller,
  args: Record<string, unknown>,
): Promise<CallToolResultV2> {
  const input = LIST_ARGS.safeParse(args);
  if (!input.success) return toolResult(z.prettifyError(input.error), true);
  const agents = await listRunnableAgents(caller.auth);
  const scopes = await getStorage().agents.scopes(agents);
  const matches = (wanted: string | undefined, actual?: string): boolean =>
    wanted === undefined || wanted.toLowerCase() === actual?.toLowerCase();
  const listed = agents
    .map(({ agentId, name, description }) => ({
      name: name,
      ...(description ? { description: description } : {}),
      ...scopes.get(agentId),
      id: agentId,
    }))
    .filter(
      ({ project, stage }) =>
        matches(input.data.project, project) &&
        matches(input.data.stage, stage),
    );

  return toolResult(
    listed.length
      ? JSON.stringify({ agents: listed })
      : "No agents match. This credential can run none, or the project and stage filter left none.",
    false,
  );
}

/** A key or token core already trusts, else an AuthKit OAuth token, else the 401 or 403. */
async function mcpAuth(request: CoreRequest): Promise<McpAuth | Response> {
  const { headers } = request;
  const auth = await resolveBearerAuth(headers);
  if (auth && auth.kind !== "admin") return auth;
  const token = extractBearerToken(headers.authorization);
  if (auth || !token) return mcpUnauthorized(false);
  const signedIn = await resolveAuthKitAuth(
    token,
    request.query.get("org")?.trim() || undefined,
  );
  if (signedIn.kind === "signed-in") return signedIn.auth;
  if (signedIn.kind === "refused") return errorResponse(403, signedIn.message);

  return mcpUnauthorized(true);
}

function promptAnswers(
  prompt: PendingQuestion,
  response: ElicitResultV2,
): Record<string, string[]> {
  return Object.fromEntries(
    prompt.questions.map((question) => {
      const value =
        response.action === "accept"
          ? response.content?.[question.id]
          : undefined;

      return [
        question.id,
        [value === undefined ? DECLINED_ANSWER : String(value)],
      ];
    }),
  );
}

/** One form per open prompt, each of its questions an enum of the option labels. */
/** A run call that missed, as a tool error the model can read; anything else is rethrown. */
function protocolErrorResult(error: unknown): CallToolResultV2 {
  if (error instanceof ProtocolError) return toolResult(error.message, true);
  throw error;
}

function questionRequest(prompt: PendingQuestion): ElicitRequestV2 {
  return {
    method: "elicitation/create",
    params: {
      mode: "form",
      message: prompt.questions.map((question) => question.question).join("\n"),
      requestedSchema: {
        type: "object",
        properties: Object.fromEntries(
          prompt.questions.map((question) => [
            question.id,
            {
              type: "string",
              title: question.header,
              description: question.question,
              enum: question.options.map((option) => option.label),
            },
          ]),
        ),
        required: prompt.questions.map((question) => question.id),
      },
    },
  };
}

async function readRun(
  caller: McpCaller,
  runId: string,
): Promise<RunStatus | null> {
  const response = await caller.replay(
    runRequest(caller, "GET", `${RUN_PATH}/${encodeURIComponent(runId)}`),
  );

  if (response.ok) return (await response.json()) as RunStatus;
  // A run id core never issued is a 400, one it doesn't know a 404.
  if (response.status === 400 || response.status === 404) return null;
  throw new ProtocolError(
    ProtocolErrorCode.InternalError,
    await errorText(response),
  );
}

function requireTaskCapability(ctx: ServerContext): void {
  if (!hasTaskClientCapabilityV2({ _meta: ctx.mcpReq.envelope })) {
    throw new MissingRequiredClientCapabilityError({
      requiredCapabilities: TASK_CAPABILITY,
    });
  }
}

/** Follows each answered prompt from the task's run to the one it now stands at. */
async function resolveTask(
  caller: McpCaller,
  taskId: string,
): Promise<TaskRuns> {
  const root = await readRun(caller, taskId);
  if (!root) throw unknownTask(taskId);
  let current = root;
  while (
    current.status === "awaiting_approval" ||
    current.status === "awaiting_input"
  ) {
    const next = await nextRun(caller, current);
    if (!next) break;
    current = next;
  }

  return { root: root, current: current };
}

function runRequest(
  caller: McpCaller,
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>,
): CoreRequest {
  return {
    ...caller.request,
    method: method,
    path: path,
    search: "",
    query: new URLSearchParams(),
    headers: { ...caller.request.headers, "content-type": "application/json" },
    body: body === undefined ? "" : JSON.stringify(body),
  };
}

/**
 * A refused write is the task's own failure to report. A 409 on an answer
 * means it was already given; on an approval it means another decision won.
 */
async function sendRunRequest(
  caller: McpCaller,
  body: Record<string, unknown>,
  settledOnConflict: boolean,
): Promise<void> {
  const response = await caller.replay(
    runRequest(caller, "POST", RUN_PATH, body),
  );
  if (!response.ok && !(settledOnConflict && response.status === 409)) {
    throw new ProtocolError(
      ProtocolErrorCode.InternalError,
      await errorText(response),
    );
  }
}

/** Starts a background run and answers its id, or the tool error that refused it. */
async function startRun(
  caller: McpCaller,
  agentId: string,
  input: z.infer<typeof ASK_ARGS>,
): Promise<string | CallToolResultV2> {
  const id = `${RUN_PREFIX}${crypto.randomUUID()}`;
  const started = await caller.replay(
    runRequest(caller, "POST", RUN_PATH, {
      agentId: agentId,
      eventId: id,
      conversationKey: input.conversationId ?? id,
      background: true,
      events: [{ role: "user", content: input.prompt }],
    }),
  );
  if (started.status === 404) {
    return toolResult(
      `Agent ${agentId} can no longer be run. Call ${LIST_TOOL} to see the agents you can ask.`,
      true,
    );
  }
  if (!started.ok) {
    return toolResult(await errorText(started), true);
  }

  return ((await started.json()) as AsyncRequestAccepted).runId;
}

async function startedTask(
  caller: McpCaller,
  runId: string,
): Promise<CreateTaskResultV2> {
  // The run is already going, so a failed first read still hands back its id:
  // a retry would start a second run.
  const run = await readRun(caller, runId).catch((): null => null);
  const now = new Date().toISOString();

  return {
    resultType: "task",
    taskId: runId,
    status: run ? taskFromRuns({ root: run, current: run }).status : "working",
    createdAt: run?.createdAt ?? now,
    lastUpdatedAt: run?.lastUpdatedAt ?? now,
    ttlMs: null,
    pollIntervalMs: POLL_INTERVAL_MS,
  };
}

function stillWorking(runId: string): CallToolResultV2 {
  return toolResult(
    `Still working. Call ${CONTINUE_TOOL} with runId "${runId}" for the answer.`,
    false,
  );
}

function toolResult(text: string, isError: boolean): CallToolResultV2 {
  return {
    resultType: "complete",
    content: [{ type: "text", text: text }],
    isError: isError,
  };
}

/** Every task call that misses: no such run, or one this caller may not read. */
function unknownTask(taskId: string): ProtocolError {
  return new ProtocolError(
    ProtocolErrorCode.InvalidParams,
    `No task ${taskId}`,
  );
}

/**
 * Polls a run until it can tell the caller something. `answeredRunId` is a run just answered,
 * whose row keeps saying it waits until the continuation is admitted.
 */
async function waitForRun(
  caller: McpCaller,
  runId: string,
  signal: AbortSignal,
  answeredRunId?: string,
): Promise<CallToolResultV2> {
  const deadline = Date.now() + SYNC_WAIT_MS;
  let pollMs = SYNC_FIRST_POLL_MS;
  for (;;) {
    const runs = await resolveTask(caller, runId).catch((error: unknown) => {
      if (
        error instanceof ProtocolError &&
        error.code === ProtocolErrorCode.InvalidParams
      ) {
        throw error;
      }

      return null;
    });
    // The run is already going: a failed read still hands back its id, so a retry
    // does not start a second run.
    if (!runs) return stillWorking(runId);
    const { status } = taskFromRuns(runs);
    const settled =
      status !== "working" &&
      !(status === "input_required" && runs.current.runId === answeredRunId);
    if (settled || signal.aborted || Date.now() + pollMs >= deadline) {
      return directReply(runs);
    }
    await Bun.sleep(pollMs);
    pollMs = Math.min(pollMs * 2, POLL_INTERVAL_MS);
  }
}

async function updateTask(
  caller: McpCaller,
  taskId: string,
  responses: Record<string, unknown>,
): Promise<void> {
  const { current } = await resolveTask(caller, taskId);
  if (current.status === "awaiting_input") {
    await answerQuestions(caller, current, responses);
  } else if (current.status === "awaiting_approval") {
    await answerApprovals(caller, current, responses);
  }
}
