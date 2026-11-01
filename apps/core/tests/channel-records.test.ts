import { SlackAdapter } from "@chat-adapter/slack";
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { createHmac } from "node:crypto";
import {
  createIncomingEventRouter,
  type ChannelInboundEvent,
} from "../src/harness/integrations.ts";
import type { AgentConfig } from "../src/shared/domain/agent-config.ts";
import type { AgentRecord } from "../src/shared/domain/agents.ts";
import {
  applyChannelRecord,
  channelActorRoles,
  channelRecordMatchesWorkspace,
  normalizeChannelRecordConfig,
  resolveChannelAgentId,
  type ChannelRecord,
} from "../src/shared/domain/channel-record.ts";
import { setStorageForTests, type Storage } from "../src/shared/storage.ts";
import { coreRequest, requestBodyText, requestUrl } from "./helpers/http.ts";

// Slack users.info goes through axios, which no fetch stub sees and which retries past the
// timeout. Storage is stubbed in beforeAll: bun shares the module registry across test files.
const getSlackUser = spyOn(SlackAdapter.prototype, "getUser");
beforeAll(() => {
  getSlackUser.mockResolvedValue(null);
  setStorageForTests({
    agentPolicies: {
      getById: async (_accountId: string, policyId: string) => ({
        accountId: "acct_test",
        policyId: policyId,
        name: policyId,
        document: { version: 1 as const, rules: [] },
        status: "active" as const,
        createdAt: "2026-07-20T00:00:00.000Z",
        updatedAt: "2026-07-20T00:00:00.000Z",
      }),
    },
  } as unknown as Storage);
});

afterAll(() => {
  getSlackUser.mockRestore();
  setStorageForTests(null);
});

const ACCOUNT = {
  accountId: "acct_test",
  username: "test-account",
  description: "Test account",
  secretHash: "hash",
  status: "active" as const,
  config: {},
  createdAt: "2026-07-20T00:00:00.000Z",
  updatedAt: "2026-07-20T00:00:00.000Z",
};

const TELEGRAM_CHANNEL = {
  botToken: "bot-token",
  webhookSecret: "telegram-secret",
  allowedChannelIds: ["123"],
};

const TELEGRAM_CONFIG: AgentConfig = {
  channels: { telegram: TELEGRAM_CHANNEL },
};

const SUPPORT_AGENT: AgentRecord = {
  accountId: "acct_test",
  agentId: "agent_support",
  name: "Support",
  config: TELEGRAM_CONFIG,
  createdAt: "2026-07-20T00:00:00.000Z",
  updatedAt: "2026-07-20T00:00:00.000Z",
};

// Only Support's secret verifies; the record, not the credentials, picks the agent that answers.
const SALES_AGENT: AgentRecord = {
  ...SUPPORT_AGENT,
  agentId: "agent_sales",
  name: "Sales",
  config: {
    ...TELEGRAM_CONFIG,
    channels: {
      telegram: {
        ...TELEGRAM_CHANNEL,
        webhookSecret: "sales-telegram-secret",
      },
    },
  },
};

const SLACK_MESSAGE_TS = "1713916800.000030";

const SLACK_AGENT: AgentRecord = {
  ...SUPPORT_AGENT,
  agentId: "agent_slack",
  name: "Slack desk",
  config: {
    channels: {
      slack: { botToken: "slack-bot-token", signingSecret: "slack-secret" },
    },
  },
};

function channelRecord(overrides: Partial<ChannelRecord> = {}): ChannelRecord {
  return {
    accountId: "acct_test",
    channelRecordId: "chan_1",
    platform: "telegram",
    externalId: "123",
    name: "#sales",
    config: { agentBindings: [{ agentId: "agent_sales" }] },
    status: "active",
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
    ...overrides,
  };
}

describe("channel record resolution", () => {
  it("routes an account-scoped webhook to the agent the record binds", async () => {
    const runs: ChannelInboundEvent[] = [];
    const response = await route({
      records: { "telegram:123": channelRecord() },
      runs: runs,
      path: "/v1/webhooks/acct_test/telegram",
    });

    expect(response.statusCode).toBe(200);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.agentId).toBe("agent_sales");
    expect(runs[0]!.agentConfig?.channels?.telegram).toEqual(TELEGRAM_CHANNEL);
    expect(runs[0]!.conversationKey).toContain("agent:agent_sales:");
  });

  it("falls back to the receiving agent when no record claims the channel", async () => {
    const runs: ChannelInboundEvent[] = [];
    const response = await route({
      records: {},
      runs: runs,
      path: "/v1/webhooks/acct_test/telegram",
    });

    expect(response.statusCode).toBe(200);
    expect(runs[0]!.agentId).toBe("agent_support");
  });

  it("no longer routes a webhook that names an agent in the URL", async () => {
    const runs: ChannelInboundEvent[] = [];
    const response = await route({
      records: { "telegram:123": channelRecord() },
      runs: runs,
      path: "/v1/webhooks/acct_test/agent_support/telegram",
    });

    // Gone, not redirected: a stale provider URL must not quietly run the wrong agent.
    expect(response.statusCode).toBe(404);
    expect(runs).toHaveLength(0);
  });

  it("keeps the receiving agent when the bound agent is gone", async () => {
    const runs: ChannelInboundEvent[] = [];
    await route({
      records: {
        "telegram:123": channelRecord({
          config: { agentBindings: [{ agentId: "agent_missing" }] },
        }),
      },
      runs: runs,
      path: "/v1/webhooks/acct_test/telegram",
    });

    expect(runs[0]!.agentId).toBe("agent_support");
  });

  it("refuses the turn when the record lookup fails", async () => {
    const runs: ChannelInboundEvent[] = [];
    const response = await route({
      records: {},
      runs: runs,
      path: "/v1/webhooks/acct_test/telegram",
      channelRecordLoader: async () => {
        throw new Error("convex unreachable");
      },
    });

    // Running the receiving agent would skip the record's policies and denyTools: fail closed.
    expect(response.statusCode).toBe(200);
    expect(runs).toHaveLength(0);
  });

  it("refuses without a 500 when the record loader throws synchronously", async () => {
    const runs: ChannelInboundEvent[] = [];
    const response = await route({
      records: {},
      runs: runs,
      path: "/v1/webhooks/acct_test/telegram",
      // Throws before a promise exists, as the default loader does on a partial storage stub.
      channelRecordLoader: (() => {
        throw new TypeError("undefined is not an object");
      }) as never,
    });

    expect(response.statusCode).toBe(200);
    expect(runs).toHaveLength(0);
  });

  it("refuses without a 500 when storage has no channelRecords at all", async () => {
    const runs: ChannelInboundEvent[] = [];
    const waited: Promise<unknown>[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async (): Promise<Response> => Response.json({ ok: true }),
      { preconnect: originalFetch.preconnect },
    );
    const router = createIncomingEventRouter({
      accountLoader: async () => ACCOUNT,
      agentLoader: async () => SUPPORT_AGENT,
      agentLister: async () => [SUPPORT_AGENT],
      deploymentLoader: async () => null,
      waitUntil: (promise) => {
        waited.push(Promise.resolve(promise).catch(() => undefined));
      },
    });

    let response: Response;
    try {
      response = await router(
        coreRequest(
          "POST",
          "/v1/webhooks/acct_test/telegram",
          { "x-telegram-bot-api-secret-token": "telegram-secret" },
          {
            update_id: 7,
            message: {
              message_id: 9,
              date: 1713916800,
              text: "hello",
              chat: { id: 123, type: "private" },
              from: { id: 456, is_bot: false, username: "alice" },
            },
          },
        ),
        {
          handleDirectRequest: async () => new Response("ok"),
          handleChannelRequest: async (event: ChannelInboundEvent) => {
            runs.push(event);
          },
        },
      );
      await Promise.all(waited);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(response.status).toBe(200);
    expect(runs).toHaveLength(0);
  });

  it("rejects an account-scoped webhook no agent's credentials verify", async () => {
    const response = await route({
      records: {},
      runs: [],
      path: "/v1/webhooks/acct_test/telegram",
      headers: { "x-telegram-bot-api-secret-token": "wrong-secret" },
    });

    expect(response.statusCode).toBe(401);
  });

  it("reaches an agent that configures the channel behind many that do not", async () => {
    const runs: ChannelInboundEvent[] = [];
    const noise: AgentRecord[] = Array.from(
      { length: 30 },
      (_unused, index) => ({
        ...SUPPORT_AGENT,
        agentId: `agent_noise_${index}`,
        config: {},
      }),
    );
    const response = await route({
      records: {},
      runs: runs,
      path: "/v1/webhooks/acct_test/telegram",
      agents: [...noise, SUPPORT_AGENT],
    });

    expect(response.statusCode).toBe(200);
    expect(runs[0]!.agentId).toBe("agent_support");
  });

  it("layers the record's instructions and policies, but not a workspace the agent lacks", async () => {
    const runs: ChannelInboundEvent[] = [];
    await route({
      records: {
        "telegram:123": channelRecord({
          config: {
            agentBindings: [{ agentId: "agent_support" }],
            instructions: "Answer as the sales desk.",
            workspaces: [{ name: "crm", workspaceId: "ws_crm" }],
            policies: ["policy_sales"],
          },
        }),
      },
      runs: runs,
      path: "/v1/webhooks/acct_test/telegram",
    });

    const config = runs[0]!.agentConfig!;
    expect(config.agent?.system).toEqual([
      { role: "system", content: "Answer as the sales desk." },
    ]);
    expect(config.workspaces).toEqual([]);
    expect(config.policies).toEqual(["policy_sales"]);
  });

  it("attaches the roles the actor holds so policies can read them", async () => {
    const runs: ChannelInboundEvent[] = [];
    await route({
      records: {
        "telegram:123": channelRecord({
          config: {
            agentBindings: [{ agentId: "agent_support" }],
            tagRoles: [
              { roleId: "oncall", userIds: ["456"] },
              { roleId: "admin", userIds: ["999"] },
            ],
          },
        }),
      },
      runs: runs,
      path: "/v1/webhooks/acct_test/telegram",
    });

    expect(runs[0]!.identity?.userId).toBe("456");
    expect(runs[0]!.identity?.userRoles).toEqual(["oncall"]);
  });

  it("refuses the tag and answers in-channel when a policy denies the invoke", async () => {
    const runs: ChannelInboundEvent[] = [];
    const replies: string[] = [];
    const response = await route({
      records: {
        "telegram:123": channelRecord({
          config: {
            agentBindings: [{ agentId: "agent_support" }],
            policies: ["policy_ops_only"],
          },
        }),
      },
      runs: runs,
      path: "/v1/webhooks/acct_test/telegram",
      policyDenies: true,
      replies: replies,
    });

    // Slow provider retries are worse than a refusal, so the webhook still ACKs.
    expect(response.statusCode).toBe(200);
    expect(runs).toHaveLength(0);
    expect(replies[0]).toContain("Denied by policy rule ops-only");
  });

  it("lets the turn through when the denial is only audited", async () => {
    const runs: ChannelInboundEvent[] = [];
    await route({
      records: {
        "telegram:123": channelRecord({
          config: {
            agentBindings: [{ agentId: "agent_support" }],
            policies: ["policy_ops_only"],
          },
        }),
      },
      runs: runs,
      path: "/v1/webhooks/acct_test/telegram",
      policyAudits: true,
    });

    expect(runs).toHaveLength(1);
  });

  it("posts the record's inline reply to the channel, not a thread", async () => {
    const posts: Array<Record<string, unknown>> = [];
    await routeSlackMention({ replyIn: "source", posts: posts });

    expect(posts).toHaveLength(1);
    expect(posts[0]!.thread_ts).toBeUndefined();
  });

  it("posts the record's always-thread reply into a new thread", async () => {
    const posts: Array<Record<string, unknown>> = [];
    await routeSlackMention({ replyIn: "thread", posts: posts });

    expect(posts[0]!.thread_ts).toBe(SLACK_MESSAGE_TS);
  });

  it("carries the placement into the run, so a delayed reply lands there too", async () => {
    const runs: ChannelInboundEvent[] = [];
    await routeSlackMention({ replyIn: "source", runs: runs });

    expect(runs[0]!.source.threadTs).toBeUndefined();
  });

  it("threads a Slack reply when no record asks otherwise", async () => {
    const runs: ChannelInboundEvent[] = [];
    await routeSlackMention({ runs: runs });

    expect(runs[0]!.source.threadTs).toBe(SLACK_MESSAGE_TS);
  });
});

describe("channel record layering", () => {
  const base: AgentConfig = {
    agent: { system: "You are the support agent." },
    workspaces: [{ name: "docs", workspaceId: "ws_docs" }],
    policy: { policies: ["policy_base"] },
    tools: { tavilySearch: { enabled: true } },
    channels: { slack: { botToken: "t", signingSecret: "s" } },
  };

  it("appends instructions after the agent's own system prompt", () => {
    const merged = applyChannelRecord(
      base,
      channelRecord({
        platform: "slack",
        config: {
          agentBindings: [{ agentId: "a" }],
          instructions: "Escalate billing questions to #finance.",
        },
      }),
      "slack",
    );

    expect(merged.agent?.system).toEqual([
      { role: "system", content: "You are the support agent." },
      { role: "system", content: "Escalate billing questions to #finance." },
    ]);
  });

  it("unions policies without dropping the agent's own", () => {
    const merged = applyChannelRecord(
      base,
      channelRecord({
        platform: "slack",
        config: {
          agentBindings: [{ agentId: "a" }],
          policies: ["policy_base", "policy_channel"],
        },
      }),
      "slack",
    );

    expect(merged.policies).toEqual(["policy_base", "policy_channel"]);
  });

  // A workspace materialises sandbox file tools: a record may narrow access, never widen it.
  it("a record naming only unattached ids leaves no workspace", () => {
    const merged = applyChannelRecord(
      base,
      channelRecord({
        platform: "slack",
        config: {
          agentBindings: [{ agentId: "a" }],
          workspaces: [{ name: "incidents", workspaceId: "ws_inc" }],
        },
      }),
      "slack",
    );

    expect(merged.workspaces).toEqual([]);
  });

  // A record alias would inherit the default sandbox and turn a read-only mount writable.
  it("narrows to the agent's own ref for a workspace the record names", () => {
    const merged = applyChannelRecord(
      {
        ...base,
        workspaces: [
          { name: "docs", workspaceId: "ws_docs", sandbox: null },
          { name: "scratch", workspaceId: "ws_scratch" },
        ],
      },
      channelRecord({
        platform: "slack",
        config: {
          agentBindings: [{ agentId: "a" }],
          workspaces: [{ name: "incidents", workspaceId: "ws_docs" }],
        },
      }),
      "slack",
    );

    expect(merged.workspaces).toEqual([
      { name: "docs", workspaceId: "ws_docs", sandbox: null },
    ]);
  });

  it("withholds tools through denyTools, not by editing config.tools", () => {
    const merged = applyChannelRecord(
      base,
      channelRecord({
        platform: "slack",
        config: {
          agentBindings: [{ agentId: "a" }],
          denyTools: ["bash", "tavilySearch"],
        },
      }),
      "slack",
    );

    // config.tools rejects "bash" as unsupported and kills the run, so denies stay separate.
    expect(merged.denyTools).toEqual(["bash", "tavilySearch"]);
    expect(merged.tools).toEqual(base.tools);
  });

  it("unions the deny list with one already on the agent", () => {
    const merged = applyChannelRecord(
      { ...base, denyTools: ["bash"] },
      channelRecord({
        platform: "slack",
        config: {
          agentBindings: [{ agentId: "a" }],
          denyTools: ["bash", "grep"],
        },
      }),
      "slack",
    );

    expect(merged.denyTools).toEqual(["bash", "grep"]);
  });

  it("applies the record's workspace scope to the active channel", () => {
    const merged = applyChannelRecord(
      base,
      channelRecord({
        platform: "slack",
        config: {
          agentBindings: [{ agentId: "a" }],
          partition: { by: "conversation", alias: "support" },
        },
      }),
      "slack",
    );

    expect(merged.channels?.slack).toMatchObject({
      partition: { by: "conversation", alias: "support" },
    });
  });

  it("still sets the scope when the bound agent has no config for the channel", () => {
    // Account-scoped webhooks keep credentials on the receiving agent, not the one that runs.
    const merged = applyChannelRecord(
      { workspaces: [{ name: "docs", workspaceId: "ws_docs" }] },
      channelRecord({
        platform: "slack",
        config: {
          agentBindings: [{ agentId: "a" }],
          partition: { by: "conversation", alias: "support" },
        },
      }),
      "slack",
    );

    expect(merged.channels?.slack).toEqual({
      partition: { by: "conversation", alias: "support" },
    });
  });

  it("leaves the config untouched when the record adds nothing", () => {
    expect(
      applyChannelRecord(base, channelRecord({ platform: "slack" }), "slack"),
    ).toEqual(base);
  });
});

describe("channel record helpers", () => {
  it("prefers the binding marked default", () => {
    expect(
      resolveChannelAgentId(
        channelRecord({
          config: {
            agentBindings: [
              { agentId: "a" },
              { agentId: "b", isDefault: true },
            ],
          },
        }),
      ),
    ).toBe("b");
  });

  it("falls back to the first binding when none is marked default", () => {
    expect(
      resolveChannelAgentId(
        channelRecord({
          config: { agentBindings: [{ agentId: "a" }, { agentId: "b" }] },
        }),
      ),
    ).toBe("a");
  });

  it("only rejects a record when both sides name a provider workspace", () => {
    // A Slack channel id is unique inside its team, not across teams.
    expect(channelRecordMatchesWorkspace("T_A", "T_B")).toBe(false);
    expect(channelRecordMatchesWorkspace("T_A", "T_A")).toBe(true);
    expect(channelRecordMatchesWorkspace("T_A", undefined)).toBe(true);
    expect(channelRecordMatchesWorkspace(undefined, "T_B")).toBe(true);
    expect(channelRecordMatchesWorkspace(undefined, undefined)).toBe(true);
  });

  it("lists only the roles the actor actually holds", () => {
    const record = channelRecord({
      config: {
        agentBindings: [{ agentId: "a" }],
        tagRoles: [
          { roleId: "oncall", userIds: ["U1", "U2"] },
          { roleId: "admin", userIds: ["U9"] },
        ],
      },
    });

    expect(channelActorRoles(record, "U1")).toEqual(["oncall"]);
    expect(channelActorRoles(record, "U9")).toEqual(["admin"]);
    expect(channelActorRoles(record, "U5")).toEqual([]);
    expect(channelActorRoles(record, undefined)).toEqual([]);
  });
});

describe("channel record validation", () => {
  it("requires at least one agent binding", () => {
    expect(() => normalizeChannelRecordConfig({})).toThrow(
      "config.agentBindings must be a non-empty array",
    );
  });

  it("rejects two default bindings", () => {
    expect(() =>
      normalizeChannelRecordConfig({
        agentBindings: [
          { agentId: "a", isDefault: true },
          { agentId: "b", isDefault: true },
        ],
      }),
    ).toThrow("only one binding as default");
  });

  it("rejects unknown config keys", () => {
    expect(() =>
      normalizeChannelRecordConfig({
        agentBindings: [{ agentId: "a" }],
        secretToken: "nope",
      }),
    ).toThrow("config.secretToken is not supported");
  });

  it("requires an alias for a conversation-level workspace scope", () => {
    expect(() =>
      normalizeChannelRecordConfig({
        agentBindings: [{ agentId: "a" }],
        partition: { by: "conversation" },
      }),
    ).toThrow("config.partition.alias must be a non-empty string");
  });

  it("rejects an alias on a shared partition", () => {
    expect(() =>
      normalizeChannelRecordConfig({
        agentBindings: [{ agentId: "a" }],
        partition: { by: "shared", alias: "support" },
      }),
    ).toThrow("only supported when by is conversation");
  });

  it("rejects an unknown reply target", () => {
    expect(() =>
      normalizeChannelRecordConfig({
        agentBindings: [{ agentId: "a" }],
        replyIn: "sometimes",
      }),
    ).toThrow("config.replyIn must be one of: thread, source");
  });
});

async function routeSlackMention(options: {
  replyIn?: "thread" | "source";
  posts?: Array<Record<string, unknown>>;
  runs?: ChannelInboundEvent[];
}): Promise<{ statusCode: number }> {
  const body = {
    type: "event_callback",
    event_id: "evt-thread-policy",
    team_id: "T1",
    authorizations: [{ user_id: "BOT", is_bot: true }],
    event: {
      type: "app_mention",
      text: "<@BOT> status?",
      channel: "C1",
      channel_type: "channel",
      user: "U1",
      ts: SLACK_MESSAGE_TS,
    },
  };
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = createHmac("sha256", "slack-secret")
    .update(`v0:${timestamp}:${JSON.stringify(body)}`)
    .digest("hex");

  return await route({
    records: {
      "slack:C1": channelRecord({
        platform: "slack",
        externalId: "C1",
        config: {
          agentBindings: [{ agentId: "agent_slack" }],
          ...(options.replyIn ? { replyIn: options.replyIn } : {}),
          ...(options.posts ? { policies: ["policy_ops_only"] } : {}),
        },
      }),
    },
    runs: options.runs ?? [],
    agents: [SLACK_AGENT],
    path: "/v1/webhooks/acct_test/slack",
    headers: {
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": `v0=${signature}`,
    },
    body: body,
    // A policy refusal is the only post the router makes by itself.
    ...(options.posts ? { policyDenies: true, posts: options.posts } : {}),
  });
}

async function route(options: {
  records: Record<string, ChannelRecord>;
  runs: ChannelInboundEvent[];
  path: string;
  headers?: Record<string, string>;
  policyDenies?: boolean;
  policyAudits?: boolean;
  replies?: string[];
  agents?: AgentRecord[];
  body?: Record<string, unknown>;
  posts?: Array<Record<string, unknown>>;
  channelRecordLoader?: (
    accountId: string,
    platform: string,
    externalId: string,
  ) => Promise<ChannelRecord | null>;
}): Promise<{ statusCode: number }> {
  const waited: Promise<unknown>[] = [];
  const opa = Bun.serve({
    port: 0,
    fetch: () =>
      Response.json({
        result: {
          allowed: !options.policyDenies,
          mode: options.policyAudits ? "audit" : "enforce",
          reason: options.policyDenies
            ? "Denied by policy rule ops-only"
            : options.policyAudits
              ? "Audited by policy rule ops-only: would deny, policy is not enforcing"
              : "Allowed by policy rule default",
          matchedRuleIds: options.policyDenies ? ["ops-only"] : [],
          auditedRuleIds: options.policyAudits ? ["ops-only"] : [],
        },
      }),
  });
  const previousOpaUrl = process.env.OPA_BASE_URL;
  process.env.OPA_BASE_URL = `http://127.0.0.1:${opa.port}`;
  const sentTexts: string[] = [];
  const slackPosts: Array<Record<string, unknown>> = [];
  const originalFetch = globalThis.fetch;
  type FetchInput = Parameters<typeof fetch>[0];
  globalThis.fetch = (async (input: FetchInput, init?: RequestInit) => {
    const url = requestUrl(input);
    if (new URL(url).hostname === "slack.com") {
      const body = init?.body;
      // chat.postMessage is form-encoded: an inline reply is an absent thread_ts key.
      if (new URL(url).pathname.endsWith("/chat.postMessage")) {
        slackPosts.push(
          Object.fromEntries(
            new URLSearchParams(requestBodyText(body)).entries(),
          ),
        );
      }

      return Response.json({ ok: true, ts: "1713916800.000099" });
    }
    if (new URL(url).hostname === "api.telegram.org") {
      const body = init?.body;
      if (typeof body === "string") {
        const parsed = JSON.parse(body) as {
          text?: string;
          rich_message?: { markdown?: string };
        };
        const text = parsed.text ?? parsed.rich_message?.markdown;
        if (text) sentTexts.push(text);
      }

      return Response.json({ ok: true, result: { message_id: 1 } });
    }

    return originalFetch(input, init);
  }) as typeof fetch;
  const agents = options.agents ?? [SUPPORT_AGENT, SALES_AGENT];
  const router = createIncomingEventRouter({
    accountLoader: async () => ACCOUNT,
    agentLoader: async (_accountId, agentId) =>
      agents.find((agent) => agent.agentId === agentId) ?? null,
    agentLister: async () => agents,
    channelRecordLoader:
      options.channelRecordLoader ??
      (async (_accountId, platform, externalId) =>
        options.records[`${platform}:${externalId}`] ?? null),
    deploymentLoader: async () => null,
    waitUntil: (promise) => {
      waited.push(Promise.resolve(promise).catch(() => undefined));
    },
  });

  const captureReplies = options.replies;
  let response: Response;
  try {
    response = await router(
      coreRequest(
        "POST",
        options.path,
        options.headers ?? {
          "x-telegram-bot-api-secret-token": "telegram-secret",
        },
        options.body ?? {
          update_id: 7,
          message: {
            message_id: 9,
            date: 1713916800,
            text: "hello",
            chat: { id: 123, type: "private" },
            from: { id: 456, is_bot: false, username: "alice" },
          },
        },
      ),
      {
        handleDirectRequest: async () => new Response("ok"),
        handleChannelRequest: async (event: ChannelInboundEvent) => {
          options.runs.push(event);
        },
      },
    );
    await Promise.all(waited);
  } finally {
    globalThis.fetch = originalFetch;
    await opa.stop(true);
    if (previousOpaUrl === undefined) {
      delete process.env.OPA_BASE_URL;
    } else {
      process.env.OPA_BASE_URL = previousOpaUrl;
    }
  }
  if (captureReplies) {
    captureReplies.push(...sentTexts);
  }
  options.posts?.push(...slackPosts);

  return { statusCode: response.status };
}
