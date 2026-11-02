/**
 * The runtime `/mcp` endpoint: Broods as an MCP Tasks server (protocol
 * 2026-07-28 with the `io.modelcontextprotocol/tasks` extension). Each agent
 * the caller's key can run is one tool; calling it starts a background run in
 * a fresh conversation and answers a task handle whose id is the run id.
 *
 * A translator that holds no state. Every run read and write goes back through
 * core's own run routes (`POST /v1/runs`, `GET /v1/runs/{runId}`) with the
 * caller's headers, so auth, stage scope, public access, user tokens and plan
 * limits keep one home in integrations.ts. Run mechanics stay in handler.ts.
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
import { resolveBearerAuth, type AuthContext } from "../shared/auth.ts";
import { runtime } from "../shared/convex/runtime.ts";
import type { AgentRecord } from "../shared/domain/agents.ts";
import { errorResponse, type CoreRequest } from "../shared/http.ts";
import {
  scopedDirectConversationKey,
  scopedDirectEventId,
} from "../shared/runtime-keys.ts";
import { asyncToolContinuationEventId } from "./async-tool-result.ts";
import { getIngressStatusByEventId } from "./ingress.ts";
import { listRunnableAgents } from "./integrations.ts";

export const MCP_PATH = "/mcp";

const APPROVAL_KEY_PREFIX = "approval-";
// An approval reply's event id is the waiting run's plus this, so a task can
// find the reply that carries it on without storing anything.
const APPROVAL_EVENT_SUFFIX = ":approval";
const DECLINED_ANSWER = "The user declined to answer.";
const FINISHED_STATUSES: ReadonlySet<RunStatus["status"]> = new Set([
  "completed",
  "failed",
  "expired",
]);
const POLL_INTERVAL_MS = 2_000;
const PROMPT_INPUT_SCHEMA: ToolV2["inputSchema"] = {
  type: "object",
  properties: {
    prompt: { type: "string", description: "What to ask the agent." },
  },
  required: ["prompt"],
};
const QUESTION_KEY_PREFIX = "question-";
const RUN_PATH = "/v1/runs";
// Prefixes the event id and conversation key of every run a task starts.
const RUN_PREFIX = "mcp-";
const SERVER_INFO = { name: "broods", version: "1.0.0" };
const TASK_CAPABILITY = { extensions: { [TASKS_EXTENSION_ID_V2]: {} } };
const TASK_PARAMS = GetTaskRequestV2Schema.shape.params;
const TOOL_CALL_PARAMS = z.object({
  name: z.string(),
  arguments: z.object({ prompt: z.string().trim().min(1) }),
});
const TOOL_CALL_RESULT = z.union([
  CreateTaskResultV2Schema,
  CallToolResultV2Schema,
]);

/** Core's own request handler, which every run read and write replays through. */
type McpReplay = (request: CoreRequest) => Promise<Response>;

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
  replay: McpReplay;
}

/**
 * Serves one `/mcp` request. Only 2026-07-28 traffic is served: a task needs
 * the per-request capability that revision introduced.
 */
export async function handleMcpRequest(
  request: CoreRequest,
  replay: McpReplay,
): Promise<Response> {
  const auth = await resolveBearerAuth(request.headers);
  if (!auth || auth.kind === "admin") {
    return errorResponse(401, "Unauthorized");
  }
  const caller: McpCaller = { auth: auth, request: request, replay: replay };
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
        result: toolResult(
          current.response === undefined
            ? ""
            : typeof current.response === "string"
              ? current.response
              : JSON.stringify(current.response),
          false,
        ),
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
    async (): Promise<{ tools: ToolV2[] }> => ({
      tools: (await listRunnableAgents(caller.auth)).map(agentTool),
    }),
  );
  server.setRequestHandler(
    "tools/call",
    { params: TOOL_CALL_PARAMS, result: TOOL_CALL_RESULT },
    async (params, ctx): Promise<CreateTaskResultV2 | CallToolResultV2> => {
      requireTaskCapability(ctx);

      return startTask(caller, params.name, params.arguments.prompt);
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
  // The SDK lifts `inputResponses` off the params into the request context.
  server.setRequestHandler(
    "tasks/update",
    { params: TASK_PARAMS },
    async (params, ctx): Promise<{ resultType: "complete" }> => {
      requireTaskCapability(ctx);
      await updateTask(caller, params.taskId, ctx.mcpReq.inputResponses ?? {});

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

function agentTool(agent: AgentRecord): ToolV2 {
  return {
    name: agent.agentId,
    title: agent.name,
    description: agent.description ?? `Ask the ${agent.name} agent.`,
    inputSchema: PROMPT_INPUT_SCHEMA,
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
 * Stops the task's conversation at its next model step, like `/stop`. Only a
 * key that may start runs may stop one. A task waiting on input has no live
 * run, so it stays where it is, and a finished task stops nothing: its
 * conversation may belong to a newer run by then.
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
  });
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

/** Starts a background run in a fresh conversation; its run id is the task id. */
async function startTask(
  caller: McpCaller,
  agentId: string,
  prompt: string,
): Promise<CreateTaskResultV2 | CallToolResultV2> {
  const id = `${RUN_PREFIX}${crypto.randomUUID()}`;
  const started = await caller.replay(
    runRequest(caller, "POST", RUN_PATH, {
      agentId: agentId,
      eventId: id,
      conversationKey: id,
      background: true,
      events: [{ role: "user", content: prompt }],
    }),
  );
  if (started.status === 404) {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      `Unknown tool: ${agentId}`,
    );
  }
  if (!started.ok) {
    return toolResult(await errorText(started), true);
  }
  const accepted = (await started.json()) as AsyncRequestAccepted;
  // The run is already going, so a failed first read still hands back its id:
  // a retry would start a second run.
  const run = await readRun(caller, accepted.runId).catch((): null => null);
  const now = new Date().toISOString();

  return {
    resultType: "task",
    taskId: accepted.runId,
    status: run ? taskFromRuns({ root: run, current: run }).status : "working",
    createdAt: run?.createdAt ?? now,
    lastUpdatedAt: run?.lastUpdatedAt ?? now,
    ttlMs: null,
    pollIntervalMs: POLL_INTERVAL_MS,
  };
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
