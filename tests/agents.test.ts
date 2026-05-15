/**
 * Agent persistence tests.
 * Cover account-owned agent config storage behavior without provider calls.
 */

import { afterEach, describe, expect, it, mock } from "bun:test";
import { DeleteItemCommand, GetItemCommand, QueryCommand, type AttributeValue } from "@aws-sdk/client-dynamodb";
import { dynamo, toAttributeValue } from "../functions/_shared/dynamo.ts";

const ORIGINAL_ENV = { ...process.env };
const originalSend = dynamo.send;
const sendMock = mock(async (_command: unknown) => ({}));

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  dynamo.send = originalSend;
  sendMock.mockReset();
});

describe("agent persistence", () => {
  it("validates configured predefined subagents as active same-account agents", async () => {
    process.env.AGENT_CONFIGS_TABLE_NAME = "agent-configs";
    process.env.ACCOUNT_CONFIG_ENCRYPTION_SECRET = "test-secret";
    dynamo.send = sendMock as never;
    const { validateAgentSubagentIds } = await import("../functions/_shared/agents.ts");
    const { encryptAccountConfig } = await import("../functions/_shared/accounts.ts");

    sendMock.mockImplementation(async (command: unknown) => {
      if (command instanceof GetItemCommand) {
        if (command.input.Key?.agentId?.S !== "agent_worker") {
          return {};
        }

        return {
          Item: agentItem("acct_test", "agent_worker", toAttributeValue(encryptAccountConfig({}))),
        };
      }
      throw new Error("unexpected command");
    });

    await expect(validateAgentSubagentIds("acct_test", {
      subagent: {
        enabled: true,
        allowed: ["agent_worker"],
      },
    })).resolves.toBeUndefined();
  });

  it("rejects missing predefined subagents", async () => {
    process.env.AGENT_CONFIGS_TABLE_NAME = "agent-configs";
    process.env.ACCOUNT_CONFIG_ENCRYPTION_SECRET = "test-secret";
    dynamo.send = sendMock as never;
    const { validateAgentSubagentIds } = await import("../functions/_shared/agents.ts");
    const { encryptAccountConfig } = await import("../functions/_shared/accounts.ts");

    sendMock.mockImplementation(async (command: unknown) => {
      if (command instanceof GetItemCommand) {
        if (command.input.Key?.agentId?.S === "agent_worker") {
          return {
            Item: agentItem("acct_test", "agent_worker", toAttributeValue(encryptAccountConfig({}))),
          };
        }

        return {};
      }
      throw new Error("unexpected command");
    });

    await expect(validateAgentSubagentIds("acct_test", {
      subagent: {
        enabled: true,
        allowed: ["agent_missing"],
      },
    })).rejects.toThrow("Subagent not found: agent_missing");
  });

  it("deletes all account agents across paginated query results", async () => {
    process.env.AGENT_CONFIGS_TABLE_NAME = "agent-configs";
    process.env.ACCOUNT_CONFIG_ENCRYPTION_SECRET = "test-secret";
    dynamo.send = sendMock as never;
    const { deleteAccountAgents } = await import("../functions/_shared/agents.ts");
    const { encryptAccountConfig } = await import("../functions/_shared/accounts.ts");
    const encryptedConfig = toAttributeValue(encryptAccountConfig({}));
    const pages = [
      {
        Items: [
          agentItem("acct_test", "agent_one", encryptedConfig),
          agentItem("acct_test", "agent_two", encryptedConfig),
        ],
        LastEvaluatedKey: {
          accountId: { S: "acct_test" },
          agentId: { S: "agent_two" },
        },
      },
      {
        Items: [
          agentItem("acct_test", "agent_three", encryptedConfig),
        ],
      },
    ];

    sendMock.mockImplementation(async (command: unknown) => {
      if (command instanceof GetItemCommand) {
        if (command.input.Key?.agentId?.S === "agent_worker") {
          return {
            Item: agentItem("acct_test", "agent_worker", encryptedConfig),
          };
        }

        return {};
      }

      if (command instanceof QueryCommand) {
        return pages.shift() ?? { Items: [] };
      }
      if (command instanceof DeleteItemCommand) {
        return {};
      }
      throw new Error("unexpected command");
    });

    await expect(deleteAccountAgents("acct_test")).resolves.toBe(3);

    const queryCommands = sendMock.mock.calls
      .map(([command]) => command)
      .filter((command): command is QueryCommand => command instanceof QueryCommand);
    const deleteCommands = sendMock.mock.calls
      .map(([command]) => command)
      .filter((command): command is DeleteItemCommand => command instanceof DeleteItemCommand);

    expect(queryCommands).toHaveLength(2);
    expect(queryCommands[0]?.input.ConsistentRead).toBe(true);
    expect(queryCommands[1]?.input.ExclusiveStartKey).toEqual({
      accountId: { S: "acct_test" },
      agentId: { S: "agent_two" },
    });
    expect(deleteCommands.map((command) => command.input.Key?.agentId)).toEqual([
      { S: "agent_one" },
      { S: "agent_two" },
      { S: "agent_three" },
    ]);
  });
});

function agentItem(accountId: string, agentId: string, config: AttributeValue): Record<string, AttributeValue> {
  return {
    accountId: { S: accountId },
    agentId: { S: agentId },
    name: { S: agentId },
    status: { S: "active" },
    config,
    createdAt: { S: "2026-05-08T00:00:00.000Z" },
    updatedAt: { S: "2026-05-08T00:00:00.000Z" },
  };
}
