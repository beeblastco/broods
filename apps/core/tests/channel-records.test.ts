/**
 * Channel record routing and layering.
 * Covers the account-scoped webhook picking an agent from the record, the
 * fallback when no record claims the place, and the narrow-and-add contract.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
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
import { coreRequest } from "./helpers/http.ts";

// The invoke gate reads assigned policy documents; without a stub the routing
// tests would reach the real Convex client. Scoped to this file — bun shares the
// module registry across test files, so a module-scope override would leak.
beforeAll(() => {
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
  status: "active",
  config: TELEGRAM_CONFIG,
  createdAt: "2026-07-20T00:00:00.000Z",
  updatedAt: "2026-07-20T00:00:00.000Z",
};

// Sales configures telegram but with a different secret, so only Support's
// credentials verify the incoming request. That is the real shape: one provider
// app has one credential set, and the record — not the credentials — decides
// which agent answers in a given place.
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

// Slack is the one provider whose reply has two places it can land, so it is
// where a record's threadPolicy is observable end to end.
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
      path: "/webhooks/acct_test/telegram",
    });

    expect(response.statusCode).toBe(200);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.agentId).toBe("agent_sales");
    expect(runs[0]!.agentConfig?.channels?.telegram).toEqual(TELEGRAM_CHANNEL);
    // Keys are scoped by the agent that actually runs, so two agents in one
    // channel never share a conversation.
    expect(runs[0]!.conversationKey).toContain("agent:agent_sales:");
  });

  it("falls back to the receiving agent when no record claims the channel", async () => {
    const runs: ChannelInboundEvent[] = [];
    const response = await route({
      records: {},
      runs: runs,
      path: "/webhooks/acct_test/telegram",
    });

    expect(response.statusCode).toBe(200);
    expect(runs[0]!.agentId).toBe("agent_support");
  });

  it("no longer routes a webhook that names an agent in the URL", async () => {
    const runs: ChannelInboundEvent[] = [];
    const response = await route({
      records: { "telegram:123": channelRecord() },
      runs: runs,
      path: "/webhooks/acct_test/agent_support/telegram",
    });

    // The agent-scoped shape is gone rather than redirected: a stale provider
    // URL must fail loudly instead of quietly running the wrong agent.
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
      path: "/webhooks/acct_test/telegram",
    });

    expect(runs[0]!.agentId).toBe("agent_support");
  });

  it("refuses the turn when the record lookup fails", async () => {
    const runs: ChannelInboundEvent[] = [];
    const response = await route({
      records: {},
      runs: runs,
      path: "/webhooks/acct_test/telegram",
      channelRecordLoader: async () => {
        throw new Error("convex unreachable");
      },
    });

    // Running the receiving agent here would skip a record's policies and
    // denyTools — an escalation. The channel path already needs Convex to admit
    // ingress, so failing closed costs no availability that is not already lost.
    expect(response.statusCode).toBe(200);
    expect(runs).toHaveLength(0);
  });

  it("refuses without a 500 when the record loader throws synchronously", async () => {
    const runs: ChannelInboundEvent[] = [];
    const response = await route({
      records: {},
      runs: runs,
      path: "/webhooks/acct_test/telegram",
      // A partial storage stub makes `storage.channelRecords` undefined, so the
      // default loader throws before a promise exists — `.catch` would miss it
      // and the webhook would 500 instead of refusing cleanly.
      channelRecordLoader: (() => {
        throw new TypeError("undefined is not an object");
      }) as never,
    });

    expect(response.statusCode).toBe(200);
    expect(runs).toHaveLength(0);
  });

  it("refuses without a 500 when storage has no channelRecords at all", async () => {
    // The module-scope stub above provides only `agentPolicies`, so the default
    // loader reads `undefined.getByExternalId` — the shape that broke CI.
    const runs: ChannelInboundEvent[] = [];
    const waited: Promise<unknown>[] = [];
    const router = createIncomingEventRouter({
      accountLoader: async () => ACCOUNT,
      agentLoader: async () => SUPPORT_AGENT,
      agentLister: async () => [SUPPORT_AGENT],
      deploymentLoader: async () => null,
      waitUntil: (promise) => {
        waited.push(Promise.resolve(promise).catch(() => undefined));
      },
    });

    const response = await router(
      coreRequest(
        "POST",
        "/webhooks/acct_test/telegram",
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

    expect(response.status).toBe(200);
    expect(runs).toHaveLength(0);
  });

  it("rejects an account-scoped webhook no agent's credentials verify", async () => {
    const response = await route({
      records: {},
      runs: [],
      path: "/webhooks/acct_test/telegram",
      headers: { "x-telegram-bot-api-secret-token": "wrong-secret" },
    });

    // Agents do configure telegram here, so this is a credential failure and
    // must say so — 404 would send the operator hunting a routing bug.
    expect(response.statusCode).toBe(401);
  });

  it("reaches an agent that configures the channel behind many that do not", async () => {
    const runs: ChannelInboundEvent[] = [];
    // 30 agents with no telegram block, then the one that owns the bot token.
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
      path: "/webhooks/acct_test/telegram",
      agents: [...noise, SUPPORT_AGENT],
    });

    expect(response.statusCode).toBe(200);
    expect(runs[0]!.agentId).toBe("agent_support");
  });

  // The bound agent attaches no workspace, so the record naming one is the
  // escalation case: it must reach the run with instructions and policies
  // layered on but no filesystem it did not already have.
  it("layers the record's instructions and policies, but not a workspace the agent lacks", async () => {
    const runs: ChannelInboundEvent[] = [];
    await route({
      records: {
        "telegram:123": channelRecord({
          config: {
            agentBindings: [{ agentId: "agent_support" }],
            instructions: "Answer as the sales desk.",
            workspaces: [{ name: "crm", workspaceId: "ws_crm" }],
            policyIds: ["policy_sales"],
          },
        }),
      },
      runs: runs,
      path: "/webhooks/acct_test/telegram",
    });

    const config = runs[0]!.agentConfig!;
    expect(config.agent?.system).toEqual([
      { role: "system", content: "Answer as the sales desk." },
    ]);
    expect(config.workspaces).toBeUndefined();
    expect(config.policy?.policyIds).toEqual(["policy_sales"]);
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
      path: "/webhooks/acct_test/telegram",
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
            policyIds: ["policy_ops_only"],
            policyMode: "enforce",
          },
        }),
      },
      runs: runs,
      path: "/webhooks/acct_test/telegram",
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
            policyIds: ["policy_ops_only"],
            policyMode: "audit",
          },
        }),
      },
      runs: runs,
      path: "/webhooks/acct_test/telegram",
      policyDenies: true,
      policyMode: "audit",
    });

    expect(runs).toHaveLength(1);
  });

  // The reply the router itself sends goes through the same rewritten source
  // the run gets, so a refusal is where the placement is observable end to end.
  it("posts the record's inline reply to the channel, not a thread", async () => {
    const posts: Array<Record<string, unknown>> = [];
    await routeSlackMention({ threadPolicy: "inline", posts: posts });

    expect(posts).toHaveLength(1);
    expect(posts[0]!.thread_ts).toBeUndefined();
  });

  it("posts the record's always-thread reply into a new thread", async () => {
    const posts: Array<Record<string, unknown>> = [];
    await routeSlackMention({ threadPolicy: "always-thread", posts: posts });

    expect(posts[0]!.thread_ts).toBe(SLACK_MESSAGE_TS);
  });

  it("carries the placement into the run, so a delayed reply lands there too", async () => {
    const runs: ChannelInboundEvent[] = [];
    await routeSlackMention({ threadPolicy: "inline", runs: runs });

    // handler.ts rebuilds a background job's sender from this stored source.
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
    policy: { policyIds: ["policy_base"] },
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
          policyIds: ["policy_base", "policy_channel"],
        },
      }),
      "slack",
    );

    expect(merged.policy?.policyIds).toEqual(["policy_base", "policy_channel"]);
  });

  // A workspace is what materialises the sandbox file tools, so a record naming
  // one the agent does not attach would hand out filesystem access the agent
  // never had — reading the agent must still tell you its ceiling.
  it("ignores a record workspace the agent does not attach", () => {
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

    expect(merged.workspaces).toEqual([
      { name: "docs", workspaceId: "ws_docs" },
    ]);
  });

  it("keeps a record workspace the agent already attaches", () => {
    const merged = applyChannelRecord(
      base,
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
      { name: "docs", workspaceId: "ws_docs" },
      { name: "incidents", workspaceId: "ws_docs" },
    ]);
  });

  it("keeps the agent's workspace when the record reuses its mount name", () => {
    const merged = applyChannelRecord(
      base,
      channelRecord({
        platform: "slack",
        config: {
          agentBindings: [{ agentId: "a" }],
          workspaces: [{ name: "docs", workspaceId: "ws_other" }],
        },
      }),
      "slack",
    );

    expect(merged.workspaces).toEqual([
      { name: "docs", workspaceId: "ws_docs" },
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

    // config.tools only ever names provider or account tools — writing "bash"
    // into it throws "not a supported tool" and kills the whole run, so the
    // deny list stays separate and is applied to the built tool set instead.
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
          workspaceScope: { level: "conversation", alias: "support" },
        },
      }),
      "slack",
    );

    expect(merged.channels?.slack).toMatchObject({
      workspaceScope: { level: "conversation", alias: "support" },
    });
  });

  it("still sets the scope when the bound agent has no config for the channel", () => {
    // On an account-scoped webhook the credentials sit on the receiving agent,
    // so the agent that runs may carry no slack block at all. Dropping the scope
    // here would make an isolated workspace throw at mount time.
    const merged = applyChannelRecord(
      { workspaces: [{ name: "docs", workspaceId: "ws_docs" }] },
      channelRecord({
        platform: "slack",
        config: {
          agentBindings: [{ agentId: "a" }],
          workspaceScope: { level: "conversation", alias: "support" },
        },
      }),
      "slack",
    );

    expect(merged.channels?.slack).toEqual({
      workspaceScope: { level: "conversation", alias: "support" },
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
    // A Slack channel id is unique inside its team, not across teams, so a
    // record naming team A must not drive a message from team B.
    expect(channelRecordMatchesWorkspace("T_A", "T_B")).toBe(false);
    expect(channelRecordMatchesWorkspace("T_A", "T_A")).toBe(true);
    // Telegram gives no team, so there is nothing to compare and it stands.
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
        workspaceScope: { level: "conversation" },
      }),
    ).toThrow("config.workspaceScope.alias must be a non-empty string");
  });

  it("rejects an alias on a channel-level workspace scope", () => {
    expect(() =>
      normalizeChannelRecordConfig({
        agentBindings: [{ agentId: "a" }],
        workspaceScope: { level: "channel", alias: "support" },
      }),
    ).toThrow("only supported when level is conversation");
  });

  it("rejects an unknown thread policy", () => {
    expect(() =>
      normalizeChannelRecordConfig({
        agentBindings: [{ agentId: "a" }],
        threadPolicy: "sometimes",
      }),
    ).toThrow("config.threadPolicy must be one of: always-thread, inline");
  });
});

/**
 * One Slack mention through the account-scoped webhook. A denied invoke makes
 * the router reply itself, which is the only outbound post these tests can see.
 */
async function routeSlackMention(options: {
  threadPolicy?: "always-thread" | "inline";
  posts?: Array<Record<string, unknown>>;
  runs?: ChannelInboundEvent[];
}) {
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
          ...(options.threadPolicy
            ? { threadPolicy: options.threadPolicy }
            : {}),
          // The invoke gate only evaluates when a policy is assigned, and a
          // refusal is the only reply this router sends by itself.
          ...(options.posts
            ? { policyIds: ["policy_ops_only"], policyMode: "enforce" as const }
            : {}),
        },
      }),
    },
    runs: options.runs ?? [],
    agents: [SLACK_AGENT],
    path: "/webhooks/acct_test/slack",
    headers: {
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": `v0=${signature}`,
    },
    body: body,
    // Only a refusal makes the router post; the run itself never replies here.
    ...(options.posts ? { policyDenies: true, posts: options.posts } : {}),
  });
}

async function route(options: {
  records: Record<string, ChannelRecord>;
  runs: ChannelInboundEvent[];
  path: string;
  headers?: Record<string, string>;
  policyDenies?: boolean;
  policyMode?: "enforce" | "audit";
  replies?: string[];
  agents?: AgentRecord[];
  /** Overrides the Telegram update these tests otherwise post. */
  body?: Record<string, unknown>;
  /** Outbound chat.postMessage bodies only — reactions carry no placement. */
  posts?: Array<Record<string, unknown>>;
  channelRecordLoader?: (
    accountId: string,
    platform: string,
    externalId: string,
  ) => Promise<ChannelRecord | null>;
}) {
  const waited: Promise<unknown>[] = [];
  const opa = Bun.serve({
    port: 0,
    fetch: () =>
      Response.json({
        result: {
          allowed: !options.policyDenies,
          mode: options.policyMode ?? "enforce",
          reason: options.policyDenies
            ? "Denied by policy rule ops-only"
            : "Allowed by policy rule default",
          matchedRuleIds: options.policyDenies ? ["ops-only"] : [],
        },
      }),
  });
  const previousOpaUrl = process.env.OPA_BASE_URL;
  process.env.OPA_BASE_URL = `http://127.0.0.1:${opa.port}`;
  // The refusal goes out through the real Telegram adapter, so capture the
  // outbound call rather than asserting on a mocked ChannelActions.
  const sentTexts: string[] = [];
  const slackPosts: Array<Record<string, unknown>> = [];
  const originalFetch = globalThis.fetch;
  type FetchInput = Parameters<typeof fetch>[0];
  globalThis.fetch = (async (input: FetchInput, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (new URL(url).hostname === "slack.com") {
      const body = init?.body;
      // chat.postMessage is form-encoded, and an omitted thread_ts is simply
      // an absent key — which is the whole assertion for `inline`.
      if (new URL(url).pathname.endsWith("/chat.postMessage")) {
        slackPosts.push(
          Object.fromEntries(new URLSearchParams(String(body)).entries()),
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
    // A throwing router call must not leave the fetch stub installed, the env
    // pointing at a stopped port, or the server leaked into the rest of the run.
    globalThis.fetch = originalFetch;
    opa.stop(true);
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
