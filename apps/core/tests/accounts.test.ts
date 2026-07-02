/**
 * Agent configuration tests.
 * Cover pure validation, patch merge, redaction, and runtime config projection.
 */

import { ScanCommand } from "@aws-sdk/client-dynamodb";
import { afterEach, describe, expect, it, mock } from "bun:test";
import {
  getStorage,
  mergeAgentConfig,
  normalizeAgentConfig,
  normalizeUpdateAccountInput,
  toPublicAccount,
  toPublicAgent,
  toChannelRuntimeAgentConfig,
  toRuntimeAgentConfig,
  type AccountRecord,
  type AgentRecord,
} from "../functions/_shared/storage/index.ts";
import { dynamo } from "../functions/_shared/storage/dynamo/client.ts";

const ORIGINAL_ENV = { ...process.env };
const originalSend = dynamo.send;
const sendMock = mock(async (_command: unknown) => ({}));

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  dynamo.send = originalSend;
  sendMock.mockReset();
});

describe("agent config", () => {
  it("deletes config keys with null patch values and preserves redacted secrets", () => {
    const merged = mergeAgentConfig({
      sandbox: "sb_old",
      channels: {
        telegram: {
          id: "telegramChannel",
          botToken: "real-token",
          webhookSecret: "real-secret",
          allowedChatIds: [123],
        },
      },
    }, {
      sandbox: null,
      channels: {
        telegram: {
          id: "telegramChannel",
          botToken: "********",
          webhookSecret: null,
        },
      },
    });

    expect(merged).toEqual({
      channels: {
        telegram: {
          id: "telegramChannel",
          botToken: "real-token",
          allowedChatIds: [123],
        },
      },
    });
  });

  it("validates runtime numeric config as positive bounded integers", () => {
    expect(() => normalizeAgentConfig({ agent: { maxTurn: 0 } })).toThrow(
      "config.agent.maxTurn must be an integer from 1 to 100",
    );
    expect(() => normalizeAgentConfig({ session: { compaction: { maxContextLength: 1.5 } } })).toThrow(
      "config.session.compaction.maxContextLength must be an integer from 1 to 500000",
    );
    // sandbox + workspaces are now references to standalone records.
    expect(() => normalizeAgentConfig({ sandbox: "" })).toThrow(
      "config.sandbox must be a non-empty string",
    );
    expect(() => normalizeAgentConfig({ workspaces: "x" })).toThrow(
      "config.workspaces must be an array",
    );
    expect(() => normalizeAgentConfig({ workspaces: [{ workspaceId: "ws_a" }] })).toThrow(
      "config.workspaces[0].name must be a non-empty string",
    );
    expect(() => normalizeAgentConfig({ workspaces: [{ name: "notes" }] })).toThrow(
      "config.workspaces[0].workspaceId must be a non-empty string",
    );
    expect(() => normalizeAgentConfig({ workspaces: [{ name: "team/shared", workspaceId: "ws_a" }] })).toThrow(
      "config.workspaces[0].name must use only letters, numbers, dots, underscores, or hyphens",
    );
    expect(() => normalizeAgentConfig({
      workspaces: [{ name: "dup", workspaceId: "ws_a" }, { name: "dup", workspaceId: "ws_b" }],
    })).toThrow('config.workspaces[1].name "dup" is used more than once');
    expect(() => normalizeAgentConfig({
      workspaces: [{ name: "notes", workspaceId: "ws_a", sandbox: "" }],
    })).toThrow("config.workspaces[0].sandbox must be a non-empty string or null");
    // A per-workspace sandbox id, and `null` to force read-only, are both accepted.
    expect(normalizeAgentConfig({
      sandbox: "sb_1",
      workspaces: [
        { name: "notes", workspaceId: "ws_a" },
        { name: "team", workspaceId: "ws_b", sandbox: "sb_2" },
        { name: "docs", workspaceId: "ws_c", sandbox: null },
      ],
    })).toEqual({
      sandbox: "sb_1",
      workspaces: [
        { name: "notes", workspaceId: "ws_a" },
        { name: "team", workspaceId: "ws_b", sandbox: "sb_2" },
        { name: "docs", workspaceId: "ws_c", sandbox: null },
      ],
    });
  });

  it("validates lifecycle webhook hook config", () => {
    expect(normalizeAgentConfig({
      hooks: {
        webhooks: [{
          enabled: true,
          url: "https://hooks.example/agent-events",
          secret: "hook-secret",
          events: ["agent.started", "tool.result", "subagent.task.finished"],
        }],
      },
    })).toMatchObject({
      hooks: {
        webhooks: [{
          enabled: true,
          events: ["agent.started", "tool.result", "subagent.task.finished"],
        }],
      },
    });

    expect(() => normalizeAgentConfig({
      hooks: {
        webhooks: "not-an-array",
      },
    })).toThrow("config.hooks.webhooks must be an array");

    expect(() => normalizeAgentConfig({
      hooks: {
        webhooks: [{
          enabled: true,
          secret: "hook-secret",
        }],
      },
    })).toThrow("config.hooks.webhooks[0].url is required when config.hooks.webhooks[0].enabled is true");

    expect(() => normalizeAgentConfig({
      hooks: {
        webhooks: [{
          enabled: true,
          url: "http://hooks.example/agent-events",
          secret: "hook-secret",
        }],
      },
    })).toThrow("config.hooks.webhooks[0].url must use https");

    expect(() => normalizeAgentConfig({
      hooks: {
        webhooks: [{
          enabled: true,
          url: "https://hooks.example/agent-events",
          secret: "hook-secret",
          events: ["unknown.event"],
        }],
      },
    })).toThrow("config.hooks.webhooks[0].events must be an array of:");
  });

  it("validates agent model config", () => {
    expect(normalizeAgentConfig({
      provider: {
        google: {
          apiKey: "google-key",
        },
        openai: {
          apiKey: "openai-key",
          project: "project-id",
          baseURL: "https://api.openai.example/v1",
        },
        anthropic: {
          apiKey: "anthropic-key",
          baseURL: "https://api.anthropic.example/v1",
        },
        bedrock: {
          region: "us-east-1",
          apiKey: "bedrock-key",
        },
        gateway: {
          apiKey: "gateway-key",
        },
      },
      model: {
        provider: "google",
        modelId: "gemini-custom",
        temperature: 0.2,
        providerOptions: {
          google: {
            thinkingConfig: {
              thinkingBudget: 8192,
              includeThoughts: true,
              thinkingLevel: "high",
            },
          },
        },
      },
    })).toEqual({
      provider: {
        google: {
          apiKey: "google-key",
        },
        openai: {
          apiKey: "openai-key",
          project: "project-id",
          baseURL: "https://api.openai.example/v1",
        },
        anthropic: {
          apiKey: "anthropic-key",
          baseURL: "https://api.anthropic.example/v1",
        },
        bedrock: {
          region: "us-east-1",
          apiKey: "bedrock-key",
        },
        gateway: {
          apiKey: "gateway-key",
        },
      },
      model: {
        provider: "google",
        modelId: "gemini-custom",
        temperature: 0.2,
        providerOptions: {
          google: {
            thinkingConfig: {
              thinkingBudget: 8192,
              includeThoughts: true,
              thinkingLevel: "high",
            },
          },
        },
      },
    });

    expect(() => normalizeAgentConfig({
      model: {
        provider: 12,
      },
    })).toThrow("config.model.provider must be one of: google, openai, anthropic, bedrock, gateway, minimax");

    for (const key of ["options", "thinking", "thinkingConfig", "unknownSetting"]) {
      expect(() => normalizeAgentConfig({
        model: {
          [key]: {},
        },
      })).toThrow(`config.model.${key} is not supported; use config.model.providerOptions for provider-specific settings`);
    }

    expect(() => normalizeAgentConfig({
      model: {
        providerOptions: "bad",
      },
    })).toThrow("config.model.providerOptions must be an object");

    // Unified v7 reasoning setting: level enum, not provider thinking objects.
    expect(() => normalizeAgentConfig({
      model: {
        reasoning: "very-high",
      },
    })).toThrow("config.model.reasoning must be one of: provider-default, none, minimal, low, medium, high, xhigh");
    expect(normalizeAgentConfig({
      model: {
        reasoning: "high",
      },
    })).toMatchObject({ model: { reasoning: "high" } });

    expect(normalizeAgentConfig({
      agent: {
        system: [{
          role: "system",
          content: "Persistent policy.",
          providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
        }],
      },
    })).toEqual({
      agent: {
        system: [{
          role: "system",
          content: "Persistent policy.",
          providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
        }],
      },
    });

    expect(() => normalizeAgentConfig({
      agent: {
        system: [{ role: "user", content: "wrong role" }],
      },
    })).toThrow("config.agent.system must be a string, SystemModelMessage, or SystemModelMessage[]");

    expect(() => normalizeAgentConfig({
      provider: {
        openai: {
          apiKey: "openai-key",
          baseURL: "http://127.0.0.1:11434/v1",
        },
      },
    })).toThrow("config.provider.openai.baseURL must use https");

    expect(() => normalizeAgentConfig({
      provider: {
        anthropic: {
          apiKey: "anthropic-key",
          baseURL: "https://10.0.0.5/v1",
        },
      },
    })).toThrow("config.provider.anthropic.baseURL must not point to a private or internal address");

    expect(normalizeAgentConfig({
      model: {
        output: {
          type: "object",
          name: "Answer",
          description: "A structured answer.",
          schema: {
            type: "object",
            properties: { answer: { type: "string" } },
            required: ["answer"],
            additionalProperties: false,
          },
        },
      },
    })).toEqual({
      model: {
        output: {
          type: "object",
          name: "Answer",
          description: "A structured answer.",
          schema: {
            type: "object",
            properties: { answer: { type: "string" } },
            required: ["answer"],
            additionalProperties: false,
          },
        },
      },
    });

    expect(normalizeAgentConfig({
      model: {
        output: {
          type: "array",
          element: {
            type: "object",
            properties: { label: { type: "string" } },
            required: ["label"],
          },
        },
      },
    })).toMatchObject({ model: { output: { type: "array" } } });

    expect(normalizeAgentConfig({
      model: {
        output: {
          type: "choice",
          options: ["accept", "reject"],
        },
      },
    })).toMatchObject({ model: { output: { type: "choice" } } });

    expect(normalizeAgentConfig({
      model: {
        output: {
          type: "json",
        },
      },
    })).toMatchObject({ model: { output: { type: "json" } } });

    expect(() => normalizeAgentConfig({
      model: {
        output: "bad",
      },
    })).toThrow("config.model.output must be an object");

    expect(() => normalizeAgentConfig({
      model: {
        output: {
          type: "object",
        },
      },
    })).toThrow("config.model.output.schema must be an object");

    expect(() => normalizeAgentConfig({
      model: {
        output: {
          type: "array",
        },
      },
    })).toThrow("config.model.output.element must be an object");

    expect(() => normalizeAgentConfig({
      model: {
        output: {
          type: "choice",
          options: [],
        },
      },
    })).toThrow("config.model.output.options must be a non-empty array of strings");

    expect(() => normalizeAgentConfig({
      provider: {
        unknown: {},
      },
    })).toThrow("config.provider.unknown is not a supported provider");

    expect(() => normalizeAgentConfig({
      provider: {
        openai: {
          headers: {
            "x-test": 1,
          },
        },
      },
    })).toThrow("config.provider.openai.headers must be an object with string values");
  });

  it("validates agent tool config", () => {
    expect(normalizeAgentConfig({
      tools: {
        tavilySearch: {
          async: true,
          needsApproval: true,
          maxResults: 5,
          includeAnswer: false,
          searchDepth: "basic",
          topic: "general",
        },
        tavilyExtract: {
          extractDepth: "advanced",
          format: "markdown",
        },
        googleSearch: {
          searchTypes: {
            webSearch: {},
          },
          timeRangeFilter: {
            startTime: "2026-05-01T00:00:00Z",
            endTime: "2026-05-02T00:00:00Z",
          },
        },
        handoffs: {
          enabled: true,
          async: true,
          pancake: {
            scenarioTagIds: {
              order: "order-tag",
              pending: "pending-tag",
            },
          },
          zalo: {
            botToken: "zalo-token",
            notifyUserIds: ["sale-1"],
          },
        },
        tool_abc123: {
          enabled: true,
          async: true,
          config: {
            completionBaseUrl: "https://agent.example",
            completionBearerToken: "secret",
          },
        },
      },
    })).toEqual({
      tools: {
        tavilySearch: {
          async: true,
          needsApproval: true,
          maxResults: 5,
          includeAnswer: false,
          searchDepth: "basic",
          topic: "general",
        },
        tavilyExtract: {
          extractDepth: "advanced",
          format: "markdown",
        },
        googleSearch: {
          searchTypes: {
            webSearch: {},
          },
          timeRangeFilter: {
            startTime: "2026-05-01T00:00:00Z",
            endTime: "2026-05-02T00:00:00Z",
          },
        },
        handoffs: {
          enabled: true,
          async: true,
          pancake: {
            scenarioTagIds: {
              order: "order-tag",
              pending: "pending-tag",
            },
          },
          zalo: {
            botToken: "zalo-token",
            notifyUserIds: ["sale-1"],
          },
        },
        tool_abc123: {
          enabled: true,
          async: true,
          config: {
            completionBaseUrl: "https://agent.example",
            completionBearerToken: "secret",
          },
        },
      },
    });

    expect(() => normalizeAgentConfig({
      tools: {
        unknownTool: { enabled: "yes" },
      },
    })).toThrow("config.tools.unknownTool is not a supported tool");

    expect(() => normalizeAgentConfig({
      tools: {
        handoffs: { enabled: true },
      },
    })).toThrow("config.tools.handoffs.pancake is required");

    expect(() => normalizeAgentConfig({
      tools: {
        handoffs: {
          enabled: true,
          pancake: {
            scenarioTagIds: {
              order: "order-tag",
              pending: "pending-tag",
            },
          },
          zalo: {
            botToken: "zalo-token",
            notifyUserIds: [],
          },
        },
      },
    })).toThrow("config.tools.handoffs.zalo.notifyUserIds must contain at least one non-empty string");

    expect(() => normalizeAgentConfig({
      tools: {
        tavilySearch: { needsApproval: "yes" },
      },
    })).toThrow("config.tools.tavilySearch.needsApproval must be a boolean");

    expect(() => normalizeAgentConfig({
      tools: {
        tavilySearch: { async: "yes" },
      },
    })).toThrow("config.tools.tavilySearch.async must be a boolean");

    expect(() => normalizeAgentConfig({
      tools: {
        tool_abc123: { config: "bad" },
      },
    })).toThrow("config.tools.tool_abc123.config must be an object");
  });

  it("validates agent skills config", () => {
    expect(normalizeAgentConfig({
      skills: {
        enabled: true,
        allowed: ["acct_test/support-flow"],
      },
    })).toEqual({
      skills: {
        enabled: true,
        allowed: ["acct_test/support-flow"],
      },
    });

    expect(() => normalizeAgentConfig({
      skills: {
        enabled: "yes",
      },
    })).toThrow("config.skills.enabled must be a boolean");

    expect(() => normalizeAgentConfig({
      skills: {
        allowed: "acct_test/support-flow",
      },
    })).toThrow("config.skills.allowed must be an array of strings");
  });

  it("validates agent subagent config", () => {
    expect(normalizeAgentConfig({
      subagent: {
        enabled: true,
        allowed: ["agent_worker"],
        context: "inherited",
        mode: "persistent",
      },
    })).toEqual({
      subagent: {
        enabled: true,
        allowed: ["agent_worker"],
        context: "inherited",
        mode: "persistent",
      },
    });

    expect(normalizeAgentConfig({
      subagent: {
        enabled: true,
        allowed: [],
        context: "new",
        mode: "ephemeral",
      },
    })).toEqual({
      subagent: {
        enabled: true,
        allowed: [],
        context: "new",
        mode: "ephemeral",
      },
    });

    expect(() => normalizeAgentConfig({
      subagent: {
        enabled: "yes",
      },
    })).toThrow("config.subagent.enabled must be a boolean");

    expect(() => normalizeAgentConfig({
      subagent: {
        allowed: "agent_worker",
      },
    })).toThrow("config.subagent.allowed must be an array of strings");

    expect(() => normalizeAgentConfig({
      subagent: {
        context: "shared",
      },
    })).toThrow("config.subagent.context must be one of: new, inherited");

    expect(() => normalizeAgentConfig({
      subagent: {
        mode: "durable",
      },
    })).toThrow("config.subagent.mode must be one of: ephemeral, persistent");
  });

  it("validates Pancake channel config", () => {
    expect(normalizeAgentConfig({
      channels: {
        pancake: {
          id: "pancakeChannel",
          pageId: "page-1",
          pageAccessToken: "page-token",
          senderId: "sender-1",
          options: {
            mode: "retail",
            ignoreTagIds: ["order-tag", "pending-tag"],
          },
        },
      },
    })).toEqual({
      channels: {
        pancake: {
          id: "pancakeChannel",
          pageId: "page-1",
          pageAccessToken: "page-token",
          senderId: "sender-1",
          options: {
            mode: "retail",
            ignoreTagIds: ["order-tag", "pending-tag"],
          },
        },
      },
    });

    expect(() => normalizeAgentConfig({
      channels: {
        pancake: {
          id: "pancakeChannel",
          pageAccessToken: 123,
        },
      },
    })).toThrow("config.channels.pancake.pageAccessToken must be a string");

    expect(() => normalizeAgentConfig({
      channels: {
        pancake: {
          id: "pancakeChannel",
          pageId: "page-1",
          pageAccessToken: "page-token",
          options: "bad",
        },
      },
    })).toThrow("config.channels.pancake.options must be an object");

    expect(() => normalizeAgentConfig({
      channels: {
        pancake: {
          id: "pancakeChannel",
          pageId: "page-1",
          pageAccessToken: "page-token",
          options: {
            ignoreTagIds: [123],
          },
        },
      },
    })).toThrow("config.channels.pancake.options.ignoreTagIds must be an array of strings");

    expect(normalizeAgentConfig({
      channels: {
        pancake: {
          id: "pancakeChannel",
          pageId: "page-1",
          pageAccessToken: "page-token",
          options: {
            customerSpecific: true,
          },
        },
      },
    })).toEqual({
      channels: {
        pancake: {
          id: "pancakeChannel",
          pageId: "page-1",
          pageAccessToken: "page-token",
          options: {
            customerSpecific: true,
          },
        },
      },
    });
  });

  it("validates channel workspace scope", () => {
    expect(normalizeAgentConfig({
      channels: {
        slack: {
          id: "slack-support",
          botToken: "slack-token",
          signingSecret: "slack-secret",
          workspaceScope: { level: "channel" },
        },
      },
    })).toEqual({
      channels: {
        slack: {
          id: "slack-support",
          botToken: "slack-token",
          signingSecret: "slack-secret",
          workspaceScope: { level: "channel" },
        },
      },
    });

    expect(() => normalizeAgentConfig({
      channels: {
        slack: {
          id: "supportSlackChannel",
          workspaceIsolationScope: "conversation",
        },
      },
    })).toThrow("config.channels.slack.workspaceIsolationScope is no longer supported; use config.channels.slack.workspaceScope");

    expect(() => normalizeAgentConfig({
      channels: {
        slack: {
          id: "supportSlackChannel",
          workspaceScope: { alias: "support", level: "conversation" },
        },
      },
    })).not.toThrow();

    expect(() => normalizeAgentConfig({
      channels: {
        slack: {
          id: "supportSlackChannel",
          workspaceScope: { alias: "support", level: "workspace" },
        },
      },
    })).toThrow("config.channels.slack.workspaceScope.level must be one of: channel, conversation");

    expect(() => normalizeAgentConfig({
      channels: {
        slack: {
          id: "supportSlackChannel",
          workspaceScope: { alias: "../support", level: "channel" },
        },
      },
    })).toThrow("config.channels.slack.workspaceScope.alias is only supported when config.channels.slack.workspaceScope.level is conversation");

    expect(() => normalizeAgentConfig({
      channels: {
        slack: {
          id: "slack-support",
          workspaceScope: { alias: "../support", level: "conversation" },
        },
      },
    })).toThrow("config.channels.slack.workspaceScope.alias must use only letters, numbers, dots, underscores, or hyphens");
  });

  it("validates Zalo channel config", () => {
    expect(normalizeAgentConfig({
      channels: {
        zalo: {
          id: "zaloChannel",
          botToken: "zalo-token",
          webhookSecret: "zalo-secret",
          allowedUserIds: ["user-1"],
        },
      },
    })).toEqual({
      channels: {
        zalo: {
          id: "zaloChannel",
          botToken: "zalo-token",
          webhookSecret: "zalo-secret",
          allowedUserIds: ["user-1"],
        },
      },
    });

    expect(() => normalizeAgentConfig({
      channels: {
        zalo: {
          id: "zaloChannel",
          botToken: 123,
        },
      },
    })).toThrow("config.channels.zalo.botToken must be a string");

    expect(() => normalizeAgentConfig({
      channels: {
        zalo: {
          id: "zaloChannel",
          botToken: "zalo-token",
          webhookSecret: "short",
        },
      },
    })).toThrow("config.channels.zalo.webhookSecret must be 8 to 256 characters");

    expect(() => normalizeAgentConfig({
      channels: {
        zalo: {
          id: "zaloChannel",
          botToken: "zalo-token",
          webhookSecret: "zalo-secret",
          allowedUserIds: [123],
        },
      },
    })).toThrow("config.channels.zalo.allowedUserIds must be an array of strings");
  });

  it("projects only runtime settings for agent sessions", () => {
    expect(toRuntimeAgentConfig({
      model: {
        provider: "google",
        modelId: "gemini-custom",
        providerOptions: {
          google: {
            thinkingConfig: {
              thinkingBudget: 8192,
              thinkingLevel: "medium",
            },
          },
        },
      },
      provider: {
        openai: {
          apiKey: "openai-key",
        },
      },
      agent: {
        maxTurn: 3,
        system: "custom system",
      },
      sandbox: "sb_1",
      workspaces: [
        { name: "personal", workspaceId: "ws_personal" },
        { name: "team", workspaceId: "ws_team" },
      ],
      session: {
        pruning: {
          enabled: false,
        },
        compaction: {
          enabled: true,
          maxContextLength: 100000,
        },
      },
      hooks: {
        webhooks: [{
          enabled: true,
          url: "https://hooks.example/agent-events",
          secret: "hook-secret",
          events: ["agent.finished"],
        }],
      },
      tools: {
        tavilySearch: { maxResults: 3 },
      },
      subagent: {
        enabled: true,
        allowed: ["agent_worker"],
        context: "new",
      },
      channels: {
        slack: {
          botToken: "xoxb-secret",
          signingSecret: "signing-secret",
        },
      },
    })).toEqual({
      model: {
        provider: "google",
        modelId: "gemini-custom",
        providerOptions: {
          google: {
            thinkingConfig: {
              thinkingBudget: 8192,
              thinkingLevel: "medium",
            },
          },
        },
      },
      provider: {
        openai: {
          apiKey: "openai-key",
        },
      },
      agent: {
        maxTurn: 3,
        system: "custom system",
      },
      sandbox: "sb_1",
      workspaces: [
        { name: "personal", workspaceId: "ws_personal" },
        { name: "team", workspaceId: "ws_team" },
      ],
      session: {
        pruning: {
          enabled: false,
        },
        compaction: {
          enabled: true,
          maxContextLength: 100000,
        },
      },
      hooks: {
        webhooks: [{
          enabled: true,
          url: "https://hooks.example/agent-events",
          secret: "hook-secret",
          events: ["agent.finished"],
        }],
      },
      tools: {
        tavilySearch: { maxResults: 3 },
      },
      subagent: {
        enabled: true,
        allowed: ["agent_worker"],
        context: "new",
      },
    });
  });

  it("projects only the active channel config for channel runtime sessions", () => {
    expect(toChannelRuntimeAgentConfig({
      agent: {
        system: "custom system",
      },
      tools: {
        handoffs: {
          enabled: true,
          pancake: {
            scenarioTagIds: {
              order: "order-tag",
              pending: "pending-tag",
            },
          },
          zalo: {
            botToken: "zalo-token",
            notifyUserIds: ["sale-1"],
          },
        },
      },
      channels: {
        pancake: {
          pageId: "page-1",
          pageAccessToken: "page-token",
        },
        slack: {
          botToken: "xoxb-secret",
          signingSecret: "signing-secret",
        },
        zalo: {
          botToken: "zalo-token",
          webhookSecret: "zalo-secret",
          allowedUserIds: ["user-1"],
        },
      },
    }, "pancake")).toEqual({
      agent: {
        system: "custom system",
      },
      tools: {
        handoffs: {
          enabled: true,
          pancake: {
            scenarioTagIds: {
              order: "order-tag",
              pending: "pending-tag",
            },
          },
          zalo: {
            botToken: "zalo-token",
            notifyUserIds: ["sale-1"],
          },
        },
      },
      channels: {
        pancake: {
          pageId: "page-1",
          pageAccessToken: "page-token",
        },
      },
    });

    expect(toChannelRuntimeAgentConfig({
      channels: {
        pancake: {
          pageId: "page-1",
          pageAccessToken: "page-token",
        },
        zalo: {
          botToken: "zalo-token",
          webhookSecret: "zalo-secret",
          allowedUserIds: ["user-1"],
        },
      },
    }, "zalo")).toEqual({
      channels: {
        zalo: {
          botToken: "zalo-token",
          webhookSecret: "zalo-secret",
          allowedUserIds: ["user-1"],
        },
      },
    });
  });

  it("rejects runtime config updates on account records", async () => {
    expect(() => normalizeUpdateAccountInput({ config: { model: { provider: "google" } } } as never)).toThrow(
      "Agent config must be updated through /accounts/me/agents/{agentId}",
    );
  });

  it("redacts secret-like config fields in public agent responses", () => {
    const agent: AgentRecord = {
      accountId: "acct_test",
      agentId: "agent_test",
      name: "test-agent",
      status: "active",
      config: {
        channels: {
        github: {
          privateKey: "private",
          webhookSecret: "secret",
          allowedRepos: ["owner/repo"],
        },
        zalo: {
          botToken: "zalo-token",
          webhookSecret: "zalo-secret",
          allowedUserIds: ["user-1"],
        },
      },
        tools: {
          tavilySearch: {
            apiKey: "tool-api-key",
            maxResults: 5,
          },
        },
        provider: {
          openai: {
            apiKey: "openai-key",
          },
          bedrock: {
            secretAccessKey: "aws-secret",
          },
        },
      },
      createdAt: "2026-05-01T00:00:00.000Z",
      updatedAt: "2026-05-01T00:00:00.000Z",
    };

    expect(toPublicAgent(agent).config).toEqual({
      channels: {
        github: {
          privateKey: "********",
          webhookSecret: "********",
          allowedRepos: ["owner/repo"],
        },
        zalo: {
          botToken: "********",
          webhookSecret: "********",
          allowedUserIds: ["user-1"],
        },
      },
      tools: {
        tavilySearch: {
          apiKey: "********",
          maxResults: 5,
        },
      },
      provider: {
        openai: {
          apiKey: "********",
        },
        bedrock: {
          secretAccessKey: "********",
        },
      },
    });
  });

  it("uses explicit accountId and agentId fields in public responses", () => {
    const account: AccountRecord = {
      accountId: "acct_test",
      username: "test",
      secretHash: "hash",
      status: "active",
      createdAt: "2026-05-01T00:00:00.000Z",
      updatedAt: "2026-05-01T00:00:00.000Z",
    };
    const agent: AgentRecord = {
      accountId: "acct_test",
      agentId: "agent_test",
      name: "test-agent",
      status: "active",
      config: {},
      createdAt: "2026-05-01T00:00:00.000Z",
      updatedAt: "2026-05-01T00:00:00.000Z",
    };

    expect(toPublicAccount(account)).toMatchObject({ accountId: "acct_test" });
    expect(toPublicAgent(agent)).toMatchObject({
      accountId: "acct_test",
      agentId: "agent_test",
    });
  });

  it("lists accounts with a strongly consistent scan for deploy upserts", async () => {
    process.env.ACCOUNT_CONFIGS_TABLE_NAME = "account-configs";
    dynamo.send = sendMock as never;

    sendMock.mockImplementation(async (command: unknown) => {
      if (command instanceof ScanCommand) {
        return { Items: [] };
      }
      throw new Error("unexpected command");
    });

    const { resetStorageForTests } = await import("../functions/_shared/storage/index.ts");
    resetStorageForTests();
    expect(getStorage().accounts.list()).resolves.toEqual([]);

    const scanCommand = sendMock.mock.calls[0]?.[0];
    expect(scanCommand).toBeInstanceOf(ScanCommand);
    expect((scanCommand as ScanCommand).input.ConsistentRead).toBe(true);
  });
});
