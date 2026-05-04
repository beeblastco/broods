/**
 * Account configuration tests.
 * Cover pure validation, patch merge, redaction, and runtime config projection.
 */

import { describe, expect, it } from "bun:test";
import {
  mergeAccountConfig,
  normalizeAccountConfig,
  toPublicAccount,
  toRuntimeAccountConfig,
  type AccountRecord,
} from "../functions/_shared/accounts.ts";

describe("account config", () => {
  it("deletes config keys with null patch values and preserves redacted secrets", () => {
    const merged = mergeAccountConfig({
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
    expect(() => normalizeAccountConfig({ agent: { maxTurn: 0 } })).toThrow(
      "config.agent.maxTurn must be an integer from 1 to 100",
    );
    expect(() => normalizeAccountConfig({ session: { compaction: { maxContextLength: 1.5 } } })).toThrow(
      "config.session.compaction.maxContextLength must be an integer from 1 to 500000",
    );
    expect(() => normalizeAccountConfig({ workspace: { memory: { namespace: "" } } })).toThrow(
      "config.workspace.memory.namespace must be a non-empty string",
    );
    expect(() => normalizeAccountConfig({ workspace: { enabled: "yes" } })).toThrow(
      "config.workspace.enabled must be a boolean",
    );
  });

  it("validates account model config", () => {
    expect(normalizeAccountConfig({
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

    expect(() => normalizeAccountConfig({
      model: {
        provider: 12,
      },
    })).toThrow("config.model.provider must be one of: google, openai, bedrock, gateway");

    expect(() => normalizeAccountConfig({
      model: {
        options: "bad",
      },
    })).toThrow("config.model.options must be an object");

    expect(() => normalizeAccountConfig({
      provider: {
        unknown: {},
      },
    })).toThrow("config.provider.unknown is not a supported provider");

    expect(() => normalizeAccountConfig({
      provider: {
        openai: {
          headers: {
            "x-test": 1,
          },
        },
      },
    })).toThrow("config.provider.openai.headers must be an object with string values");
  });

  it("validates account tool config", () => {
    expect(normalizeAccountConfig({
      tools: {
        tavilySearch: {
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
      },
    })).toEqual({
      tools: {
        tavilySearch: {
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
      },
    });

    expect(() => normalizeAccountConfig({
      tools: {
        unknownTool: { enabled: "yes" },
      },
    })).toThrow("config.tools.unknownTool is not a supported tool");
  });

  it("projects only runtime settings for agent sessions", () => {
    expect(toRuntimeAccountConfig({
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
        memory: {
          namespace: "support",
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
      tools: {
        tavilySearch: { maxResults: 3 },
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
        memory: {
          namespace: "support",
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
      tools: {
        tavilySearch: { maxResults: 3 },
      },
    });
  });

  it("redacts secret-like config fields in public account responses", () => {
    const account: AccountRecord = {
      accountId: "acct_test",
      username: "test",
      secretHash: "hash",
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

    expect(toPublicAccount(account).config).toEqual({
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
});
