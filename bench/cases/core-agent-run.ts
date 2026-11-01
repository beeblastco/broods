import {
  runAgentLoop,
  type AgentLoopStream,
} from "../../apps/core/src/harness/harness.ts";
import type {
  Session,
  TurnContextSnapshot,
} from "../../apps/core/src/harness/session.ts";
import type { AgentConfig } from "../../apps/core/src/shared/domain/agent-config.ts";
import {
  setStorageForTests,
  type Storage,
} from "../../apps/core/src/shared/storage.ts";
import { muteCoreLogs, unmuteCoreLogs } from "../fixtures/mute-core-logs.ts";
import type { BenchCase } from "../runner.ts";

const ACCOUNT_ID = "acct_bench";
const AGENT_ID = "agt_bench";
const CONVERSATION_KEY = `acct:${ACCOUNT_ID}:agent:${AGENT_ID}:api:conv_bench`;

// Groq on its default endpoint reads globalThis.fetch at call time, so the fake model
// serves it without the private-host guards a configured base URL brings in.
const AGENT_CONFIG: AgentConfig = {
  agent: {
    system: "You are the on-call assistant. Be brief.",
    maxTurn: 4,
  },
  model: { provider: "groq", modelId: "bench-model" },
  provider: { groq: { apiKey: "gsk_bench_0000" } },
  // The registry only offers list_schedules to an agent with the scheduler on.
  scheduler: { enabled: true },
};

const ANSWER =
  "Three deployments went out for payments in the last day. One rolled back: build 4182 at 14:02 UTC failed its health check and was reverted in 90 seconds.";

const ENV_FIXTURE: Readonly<Record<string, string>> = {
  ACCOUNT_CONFIG_ENCRYPTION_SECRET: "bench-only-account-config-secret-0000",
  FILESYSTEM_BUCKET_NAME: "bench-filesystem",
  MAX_AGENT_ITERATIONS: "3",
};

export const coreAgentRunCases: readonly BenchCase[] = [
  {
    name: "core/agent-run-first-token",
    iterations: 20,
    samples: 11,
    setup: installFakes,
    teardown: restoreFakes,
    run: async (): Promise<unknown> => {
      scenario = "text";
      const stream = await runAgentLoop(session(), turnContext(), AGENT_CONFIG);
      let first: unknown = null;
      for await (const part of stream.fullStream) {
        first = part;
        break;
      }
      await stream.consumeStream();
      await stream.ensureFinalized(true);

      return first;
    },
  },
  {
    name: "core/agent-run-text-turn",
    iterations: 20,
    samples: 11,
    setup: installFakes,
    teardown: restoreFakes,
    run: async (): Promise<unknown> => {
      scenario = "text";

      return (
        await drain(await runAgentLoop(session(), turnContext(), AGENT_CONFIG))
      ).text;
    },
  },
  {
    name: "core/agent-run-tool-turn",
    iterations: 20,
    samples: 11,
    setup: installFakes,
    teardown: restoreFakes,
    run: async (): Promise<unknown> => {
      scenario = "tool";
      modelCalls = 0;
      const drained = await drain(
        await runAgentLoop(session(), turnContext(), AGENT_CONFIG),
      );
      // A missing tool also costs two model calls (the error goes back), so count tool results.
      if (drained.toolResults !== 1 || modelCalls !== 2) {
        throw new Error(
          `tool turn produced ${drained.toolResults} tool results over ${modelCalls} model calls, expected 1 over 2`,
        );
      }

      return drained.text;
    },
  },
];

type Scenario = "text" | "tool";

interface Drained {
  text: number;
  toolResults: number;
}

let modelCalls = 0;
let originalFetch: typeof fetch | null = null;
let savedEnv: Record<string, string | undefined> = {};
let scenario: Scenario = "text";

async function drain(stream: AgentLoopStream): Promise<Drained> {
  const drained: Drained = { text: 0, toolResults: 0 };
  for await (const part of stream.fullStream) {
    if (part.type === "text-delta") drained.text += part.text.length;
    if (part.type === "tool-result") drained.toolResults += 1;
  }
  await stream.ensureFinalized(true);
  if (stream.didFail())
    throw new Error(stream.failureText() ?? "agent run failed");

  return drained;
}

function fakeModelFetch(input: string | URL | Request): Promise<Response> {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  if (!url.includes("/chat/completions")) {
    return Promise.reject(new Error(`bench fetch refused ${url}`));
  }
  modelCalls += 1;
  const askForTool = scenario === "tool" && modelCalls === 1;
  const body = askForTool
    ? [
        chunk({ role: "assistant", content: null }),
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "call_bench_1",
              type: "function",
              function: { name: "list_schedules", arguments: "{}" },
            },
          ],
        }),
        chunk({}, "tool_calls"),
        "data: [DONE]\n\n",
      ]
    : [
        chunk({ role: "assistant", content: "" }),
        ...ANSWER.split(" ").map((word, index) =>
          chunk({ content: (index === 0 ? "" : " ") + word }),
        ),
        chunk({}, "stop"),
        "data: [DONE]\n\n",
      ];

  return Promise.resolve(
    new Response(body.join(""), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }),
  );
}

function chunk(
  delta: Record<string, unknown>,
  finishReason: string | null = null,
): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl-bench",
    object: "chat.completion.chunk",
    created: 1_725_400_000,
    model: "bench-model",
    choices: [{ index: 0, delta: delta, finish_reason: finishReason }],
    ...(finishReason
      ? {
          usage: {
            prompt_tokens: 240,
            completion_tokens: 48,
            total_tokens: 288,
          },
        }
      : {}),
  })}\n\n`;
}

function fakeStorage(): Storage {
  const none = async (): Promise<null> => null;
  const empty = async (): Promise<never[]> => [];
  const zero = async (): Promise<number> => 0;

  return {
    accounts: {
      getById: none,
      getBySecretHash: none,
      create: async () => {
        throw new Error("not in bench");
      },
      disable: none,
      remove: async () => false,
    },
    budgets: {
      get: none,
      record: async () => {},
      claimWarning: async () => false,
    },
    agents: {
      getById: none,
      listForProduction: empty,
      listForEndpoint: empty,
      listForStage: empty,
      removeAllForAccount: zero,
    },
    agentDeployments: { getByApiKeyHash: none, touchLastUsed: async () => {} },
    channelRecords: {
      getByExternalId: none,
      getById: none,
      list: empty,
      removeAllForAccount: zero,
    },
    crons: {
      create: async () => {
        throw new Error("not in bench");
      },
      getById: none,
      list: empty,
      remove: async () => false,
      update: none,
      markFailed: async () => undefined,
      createRun: async () => {
        throw new Error("not in bench");
      },
      completeRun: async () => undefined,
      failRun: async () => undefined,
    },
    machineConnections: {
      connected: async () => undefined,
      disconnected: async () => undefined,
      seen: async () => undefined,
    },
    sandboxConfigs: { getById: none, list: empty, removeAllForAccount: zero },
    workspaceConfigs: {
      getById: none,
      list: empty,
      mintR2Credentials: async () => {
        throw new Error("the bench has no R2 workspace");
      },
      storageExternalId: async () => {
        throw new Error("the bench has no assumeRole workspace");
      },
      removeAllForAccount: zero,
    },
    accountHooks: { getById: none, removeAllForAccount: zero },
    mcp: { getById: none, removeAllForAccount: zero },
    agentPolicies: { getById: none },
    connections: { load: none, saveRefreshed: async () => false },
    roleSessions: { resolveByTokenHash: none },
    accountApiKeys: {
      resolveByKeyHash: none,
      touchLastUsed: async () => undefined,
    },
    taskUsage: { record: async () => undefined },
    auditLedger: { append: async () => undefined },
  };
}

function installFakes(): void {
  muteCoreLogs();
  savedEnv = Object.fromEntries(
    Object.keys(ENV_FIXTURE).map((name) => [name, process.env[name]]),
  );
  Object.assign(process.env, ENV_FIXTURE);
  originalFetch = globalThis.fetch;
  globalThis.fetch = fakeModelFetch as typeof fetch;
  setStorageForTests(fakeStorage());
}

function restoreFakes(): void {
  setStorageForTests(null);
  if (originalFetch) globalThis.fetch = originalFetch;
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  unmuteCoreLogs();
}

function session(): Session {
  return {
    accountId: ACCOUNT_ID,
    agentId: AGENT_ID,
    conversationKey: CONVERSATION_KEY,
    eventId: `evt_${Date.now()}`,
    filesystemNamespace: (): string => "fs-bench",
    resolvedWorkspaces: (): never[] => [],
    sandboxes: (): never[] => [],
    environmentText: (): string => "<environment>",
    persistModelMessages: async (): Promise<never[]> => [],
    renewConversationLease: async (): Promise<"renewed"> => "renewed",
    stepBoundary: async (): Promise<{
      renewal: "renewed";
      steering: null;
    }> => ({ renewal: "renewed", steering: null }),
    applySteeringIngress: async (): Promise<null> => null,
    appendIngressEvents: async (): Promise<null> => null,
    loadRefreshedSystemPromptParts: async (): Promise<{
      systemContextSnapshot: { cursor: null; messages: never[] };
      system: never[];
    }> => ({
      systemContextSnapshot: { cursor: null, messages: [] },
      system: [],
    }),
  } as never;
}

function turnContext(): TurnContextSnapshot {
  return {
    messages: [
      {
        role: "user",
        content:
          "Summarize the last three deployments for the payments service and flag any that rolled back.",
      },
    ],
    system: [
      { role: "system", content: "You are the on-call assistant. Be brief." },
    ],
    ephemeralSystem: [],
    systemContextSnapshot: { cursor: null, messages: [] },
  };
}
