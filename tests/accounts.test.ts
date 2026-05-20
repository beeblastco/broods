/**
 * Agent configuration tests.
 * Cover pure validation, patch merge, redaction, and runtime config projection.
 */

import { ScanCommand } from "@aws-sdk/client-dynamodb";
import { afterEach, describe, expect, it, mock } from "bun:test";
import {
  listAccounts,
  mergeAgentConfig,
  normalizeAgentConfig,
  toPublicAccount,
  toRuntimeAgentConfig,
  updateAccount,
  type AccountRecord,
} from "../functions/_shared/accounts.ts";
import {
  toPublicAgent,
  type AgentRecord,
} from "../functions/_shared/agents.ts";
import { dynamo } from "../functions/_shared/dynamo.ts";

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
      workspace: {
        enabled: true,
        memory: {
          namespace: "support",
        },
      },
      channels: {
        telegram: {
          botToken: "real-token",
          webhookSecret: "real-secret",
          allowedChatIds: [123],
        },
      },
    }, {
      workspace: {
        memory: {
          namespace: null,
        },
      },
      channels: {
        telegram: {
          botToken: "********",
          webhookSecret: null,
        },
      },
    });

    expect(merged).toEqual({
      workspace: {
        enabled: true,
        memory: {},
      },
      channels: {
        telegram: {
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
    expect(() => normalizeAgentConfig({ workspace: { memory: { namespace: "" } } })).toThrow(
      "config.workspace.memory.namespace must be a non-empty string",
    );
    expect(() => normalizeAgentConfig({ workspace: { enabled: "yes" } })).toThrow(
      "config.workspace.enabled must be a boolean",
    );
    expect(() => normalizeAgentConfig({ workspace: { needsApproval: "yes" } })).toThrow(
      "config.workspace.needsApproval must be a boolean",
    );
    expect(() => normalizeAgentConfig({ workspace: { memory: { enabled: "yes" } } })).toThrow(
      "config.workspace.memory.enabled must be a boolean",
    );
    expect(() => normalizeAgentConfig({ workspace: { tasks: { enabled: "yes" } } })).toThrow(
      "config.workspace.tasks.enabled must be a boolean",
    );
    expect(() => normalizeAgentConfig({ workspace: { filesystem: { enabled: "yes" } } })).toThrow(
      "config.workspace.filesystem.enabled must be a boolean",
    );
    expect(normalizeAgentConfig({
      workspace: {
        sandbox: {
          enabled: true,
          provider: "lambda",
          timeout: 30,
          memoryLimit: 512,
          outputLimitBytes: 65536,
          filesystem: {
            mount: "native",
          },
          options: {
            nodeFunctionName: "sandbox-node",
            pythonFunctionName: "sandbox-python",
            workspaceRoot: "/mnt/workspaces",
          },
        },
      },
    })).toEqual({
      workspace: {
        sandbox: {
          enabled: true,
          provider: "lambda",
          timeout: 30,
          memoryLimit: 512,
          outputLimitBytes: 65536,
          filesystem: {
            mount: "native",
          },
          options: {
            nodeFunctionName: "sandbox-node",
            pythonFunctionName: "sandbox-python",
            workspaceRoot: "/mnt/workspaces",
          },
        },
      },
    });
    expect(() => normalizeAgentConfig({ workspace: { sandbox: "yes" } })).toThrow(
      "config.workspace.sandbox must be an object",
    );
    expect(() => normalizeAgentConfig({ workspace: { sandbox: { provider: "docker" } } })).toThrow(
      "config.workspace.sandbox.provider must be one of: lambda, e2b, daytona",
    );
    expect(() => normalizeAgentConfig({ workspace: { sandbox: { filesystem: { mount: "sync" } } } })).toThrow(
      "config.workspace.sandbox.filesystem.mount must be one of: native",
    );
    expect(() => normalizeAgentConfig({ workspace: { sandbox: { timeout: 121 } } })).toThrow(
      "config.workspace.sandbox.timeout must be an integer from 1 to 120",
    );
  });

  it("validates lifecycle webhook hook config", () => {
    expect(normalizeAgentConfig({
      hooks: {
        webhook: {
          enabled: true,
          url: "https://hooks.example/agent-events",
          secret: "hook-secret",
          events: ["agent.started", "tool.result", "subagent.task.finished"],
        },
      },
    })).toMatchObject({
      hooks: {
        webhook: {
          enabled: true,
          events: ["agent.started", "tool.result", "subagent.task.finished"],
        },
      },
    });

    expect(() => normalizeAgentConfig({
      hooks: {
        webhook: {
          enabled: true,
          secret: "hook-secret",
        },
      },
    })).toThrow("config.hooks.webhook.url is required when config.hooks.webhook.enabled is true");

    expect(() => normalizeAgentConfig({
      hooks: {
        webhook: {
          enabled: true,
          url: "http://hooks.example/agent-events",
          secret: "hook-secret",
        },
      },
    })).toThrow("config.hooks.webhook.url must use https");

    expect(() => normalizeAgentConfig({
      hooks: {
        webhook: {
          enabled: true,
          url: "https://hooks.example/agent-events",
          secret: "hook-secret",
          events: ["unknown.event"],
        },
      },
    })).toThrow("config.hooks.webhook.events must be an array of:");
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
        options: {
          google: {
            thinkingConfig: {
              thinkingLevel: "low",
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
        options: {
          google: {
            thinkingConfig: {
              thinkingLevel: "low",
            },
          },
        },
      },
    });

    expect(() => normalizeAgentConfig({
      model: {
        provider: 12,
      },
    })).toThrow("config.model.provider must be one of: google, openai, bedrock, gateway, minimax");

    expect(() => normalizeAgentConfig({
      model: {
        options: "bad",
      },
    })).toThrow("config.model.options must be an object");

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
          execution: "external-dispatch",
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
        test_async: {
          enabled: true,
          async: true,
        },
        test_external_async: {
          enabled: true,
          async: true,
          execution: "external-dispatch",
          completionBaseUrl: "https://agent.example",
          completionBearerToken: "secret",
        },
      },
    })).toEqual({
      tools: {
        tavilySearch: {
          async: true,
          execution: "external-dispatch",
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
        test_async: {
          enabled: true,
          async: true,
        },
        test_external_async: {
          enabled: true,
          async: true,
          execution: "external-dispatch",
          completionBaseUrl: "https://agent.example",
          completionBearerToken: "secret",
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
        tavilySearch: { execution: "background" },
      },
    })).toThrow("config.tools.tavilySearch.execution must be one of: same-invocation, external-dispatch");

    expect(() => normalizeAgentConfig({
      tools: {
        test_external_async: { completionBearerToken: "" },
      },
    })).toThrow("config.tools.test_external_async.completionBearerToken must be a non-empty string");
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
          pageId: "page-1",
          pageAccessToken: "page-token",
          senderId: "sender-1",
        },
      },
    })).toEqual({
      channels: {
        pancake: {
          pageId: "page-1",
          pageAccessToken: "page-token",
          senderId: "sender-1",
        },
      },
    });

    expect(() => normalizeAgentConfig({
      channels: {
        pancake: {
          pageAccessToken: 123,
        },
      },
    })).toThrow("config.channels.pancake.pageAccessToken must be a string");
  });

  it("projects only runtime settings for agent sessions", () => {
    expect(toRuntimeAgentConfig({
      model: {
        provider: "google",
        modelId: "gemini-custom",
        options: {
          google: {
            thinkingConfig: {
              thinkingLevel: "low",
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
      workspace: {
        enabled: true,
        needsApproval: true,
        memory: {
          enabled: true,
          namespace: "support",
        },
        tasks: {
          enabled: true,
        },
      },
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
        webhook: {
          enabled: true,
          url: "https://hooks.example/agent-events",
          secret: "hook-secret",
          events: ["agent.finished"],
        },
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
        options: {
          google: {
            thinkingConfig: {
              thinkingLevel: "low",
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
      workspace: {
        enabled: true,
        needsApproval: true,
        memory: {
          enabled: true,
          namespace: "support",
        },
        tasks: {
          enabled: true,
        },
      },
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
        webhook: {
          enabled: true,
          url: "https://hooks.example/agent-events",
          secret: "hook-secret",
          events: ["agent.finished"],
        },
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

  it("rejects runtime config updates on account records", async () => {
    await expect(updateAccount("acct_test", { config: { model: { provider: "google" } } } as never)).rejects.toThrow(
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

    await expect(listAccounts()).resolves.toEqual([]);

    const scanCommand = sendMock.mock.calls[0]?.[0];
    expect(scanCommand).toBeInstanceOf(ScanCommand);
    expect((scanCommand as ScanCommand).input.ConsistentRead).toBe(true);
  });
});
