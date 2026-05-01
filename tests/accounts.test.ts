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
      memoryNamespace: "support",
      channels: {
        telegram: {
          botToken: "real-token",
          webhookSecret: "real-secret",
          allowedChatIds: [123],
        },
      },
    }, {
      memoryNamespace: null,
      channels: {
        telegram: {
          botToken: "********",
          webhookSecret: null,
        },
      },
    });

    expect(merged).toEqual({
      channels: {
        telegram: {
          botToken: "real-token",
          allowedChatIds: [123],
        },
      },
    });
  });

  it("validates runtime numeric config as positive bounded integers", () => {
    expect(() => normalizeAccountConfig({ maxAgentIterations: 0 })).toThrow(
      "config.maxAgentIterations must be an integer from 1 to 100",
    );
    expect(() => normalizeAccountConfig({ slidingContextWindow: 1.5 })).toThrow(
      "config.slidingContextWindow must be an integer from 1 to 200",
    );
    expect(() => normalizeAccountConfig({ memoryNamespace: "" })).toThrow(
      "config.memoryNamespace must be a non-empty string",
    );
  });

  it("projects only runtime settings for agent sessions", () => {
    expect(toRuntimeAccountConfig({
      modelId: "gemini-test",
      maxAgentIterations: 3,
      memoryNamespace: "support",
      channels: {
        slack: {
          botToken: "xoxb-secret",
          signingSecret: "signing-secret",
        },
      },
    })).toEqual({
      modelId: "gemini-test",
      maxAgentIterations: 3,
      memoryNamespace: "support",
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
    });
  });
});
