/**
 * Bot command tests.
 * Cover command parsing, execution, Discord resolution, and registration here.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  BatchWriteItemCommand,
  QueryCommand,
} from "@aws-sdk/client-dynamodb";
import { dynamo } from "../functions/_shared/storage/dynamo/client.ts";
import type { ChannelActions } from "../functions/_shared/channels.ts";
import {
  commands,
  executeCommand,
  getDiscordCommandRegistrations,
  parseCommand,
  resolveDiscordCommand,
} from "../functions/_shared/commands.ts";

const originalSend = dynamo.send;

beforeEach(() => {
  dynamo.send = mock(() => Promise.resolve({ Items: [], LastEvaluatedKey: undefined })) as never;
});

afterEach(() => {
  dynamo.send = originalSend;
  mock.restore();
});

function createMockChannelActions(overrides: Partial<ChannelActions> = {}): ChannelActions {
  return {
    sendText: mock(async () => {}),
    sendTyping: mock(async () => {}),
    reactToMessage: mock(async () => {}),
    ...overrides,
  };
}

function createCommandContext(overrides: Partial<{
  conversationKey: string;
  conversationsTableName: string;
  channel: ChannelActions;
}> = {}) {
  return {
    conversationKey: overrides.conversationKey ?? "test-convo",
    conversationsTableName: overrides.conversationsTableName ?? "TestConversations",
    channel: overrides.channel ?? createMockChannelActions(),
  };
}

describe("command definitions", () => {
  it("defines three commands with expected aliases", () => {
    expect(commands).toHaveLength(3);

    const newCmd = commands.find((c) => c.aliases.includes("/new"));
    const helpCmd = commands.find((c) => c.aliases.includes("/help"));
    const askCmd = commands.find((c) => c.aliases.includes("/ask"));

    expect(newCmd).toBeDefined();
    expect(helpCmd).toBeDefined();
    expect(askCmd).toBeDefined();
  });

  it("/new and /start share the same handler", () => {
    const newCmd = commands.find((c) => c.aliases.includes("/new"));
    const startCmd = commands.find((c) => c.aliases.includes("/start"));

    expect(newCmd).toBe(startCmd);
    expect(newCmd?.aliases).toEqual(["/new", "/start"]);
  });

  it("/ask has no execute function and is hidden from help", () => {
    const askCmd = commands.find((c) => c.aliases.includes("/ask"));

    expect(askCmd?.execute).toBeUndefined();
    expect(askCmd?.showInHelp).toBe(false);
  });

  it("all commands have discord metadata", () => {
    for (const cmd of commands) {
      expect(cmd.discord).toBeDefined();
      expect(cmd.discord?.name).toBeTruthy();
      expect(cmd.discord?.description).toBeTruthy();
    }
  });

  it("/ask discord command uses message input mode with a required prompt option", () => {
    const askCmd = commands.find((c) => c.aliases.includes("/ask"));

    expect(askCmd?.discord?.inputMode).toBe("message");
    expect(askCmd?.discord?.options).toHaveLength(1);
    expect(askCmd?.discord?.options?.[0]).toMatchObject({
      type: 3,
      name: "prompt",
      required: true,
    });
  });
});

describe("parseCommand", () => {
  it("returns the command token for valid executable commands", () => {
    expect(parseCommand("/new")).toBe("/new");
    expect(parseCommand("/start")).toBe("/start");
    expect(parseCommand("/help")).toBe("/help");
  });

  it("normalizes case and trims whitespace", () => {
    expect(parseCommand("  /NEW  ")).toBe("/new");
    expect(parseCommand("/HELP")).toBe("/help");
    expect(parseCommand("\t/Start\n")).toBe("/start");
  });

  it("extracts the first token when extra arguments are present", () => {
    expect(parseCommand("/new some extra args")).toBe("/new");
    expect(parseCommand("/help  ")).toBe("/help");
  });

  it("returns null for non-command text", () => {
    expect(parseCommand("hello world")).toBeNull();
    expect(parseCommand("")).toBeNull();
    expect(parseCommand("   ")).toBeNull();
  });

  it("returns null for non-executable commands like /ask", () => {
    expect(parseCommand("/ask")).toBeNull();
    expect(parseCommand("/ask what is 2+2")).toBeNull();
  });

  it("returns null for unknown commands", () => {
    expect(parseCommand("/unknown")).toBeNull();
    expect(parseCommand("/foo bar")).toBeNull();
  });
});

describe("executeCommand", () => {
  it("executes /new and sends confirmation reply", async () => {
    const channel = createMockChannelActions();
    const ctx = createCommandContext({ channel });

    await executeCommand("/new", ctx);

    expect(channel.sendText).toHaveBeenCalledWith("Context cleared. Starting fresh.");
  });

  it("executes /help and lists executable commands", async () => {
    const channel = createMockChannelActions();
    const ctx = createCommandContext({ channel });

    await executeCommand("/help", ctx);

    expect(channel.sendText).toHaveBeenCalledTimes(1);
    const helpText = (channel.sendText as ReturnType<typeof mock>).mock.calls[0]?.[0] as string;
    expect(helpText).toContain("Available commands:");
    expect(helpText).toContain("/new");
    expect(helpText).toContain("/help");
    expect(helpText).not.toContain("/ask");
  });

  it("does nothing for commands without an execute handler", async () => {
    const channel = createMockChannelActions();
    const ctx = createCommandContext({ channel });

    await executeCommand("/ask", ctx);

    expect(channel.sendText).not.toHaveBeenCalled();
  });

  it("does nothing for unknown command tokens", async () => {
    const channel = createMockChannelActions();
    const ctx = createCommandContext({ channel });

    await executeCommand("/bogus", ctx);

    expect(channel.sendText).not.toHaveBeenCalled();
  });

  it("sends a generic error message when command execution fails", async () => {
    const channel = createMockChannelActions();
    const ctx = createCommandContext({
      channel,
      conversationsTableName: "BoomTable",
    });

    dynamo.send = mock(() => Promise.reject(new Error("DynamoDB connection failed"))) as never;

    await executeCommand("/new", ctx);

    expect(channel.sendText).toHaveBeenCalledWith("Something went wrong. Please try again.");
  });

  it("handles non-Error exceptions during execution", async () => {
    const channel = createMockChannelActions();
    const ctx = createCommandContext({
      channel,
      conversationsTableName: "StringErrorTable",
    });

    dynamo.send = mock(() => Promise.reject("string error")) as never;

    await executeCommand("/new", ctx);

    expect(channel.sendText).toHaveBeenCalledWith("Something went wrong. Please try again.");
  });
});

describe("resolveDiscordCommand", () => {
  it("resolves a standard discord command with a command token", () => {
    const result = resolveDiscordCommand("new", "");

    expect(result).not.toBeNull();
    expect(result?.commandToken).toBe("/new");
    expect(result?.contentText).toBe("");
  });

  it("resolves a message-mode discord command with content text only", () => {
    const result = resolveDiscordCommand("ask", "what is the weather?");

    expect(result).not.toBeNull();
    expect(result?.commandToken).toBeUndefined();
    expect(result?.contentText).toBe("what is the weather?");
  });

  it("returns null for unknown discord command names", () => {
    expect(resolveDiscordCommand("unknown", "")).toBeNull();
    expect(resolveDiscordCommand("help", "")).not.toBeNull();
  });

  it("trims option text for message-mode commands", () => {
    const result = resolveDiscordCommand("ask", "  hello world  ");

    expect(result?.contentText).toBe("hello world");
  });

  it("returns null when message-mode option text is empty after trimming", () => {
    expect(resolveDiscordCommand("ask", "")).toBeNull();
    expect(resolveDiscordCommand("ask", "   ")).toBeNull();
  });

  it("preserves command token for non-message-mode commands with option text", () => {
    const result = resolveDiscordCommand("help", "extra text");

    expect(result?.commandToken).toBe("/help");
    expect(result?.contentText).toBe("extra text");
  });
});

describe("getDiscordCommandRegistrations", () => {
  it("returns registrations for all commands with discord metadata", () => {
    const registrations = getDiscordCommandRegistrations();

    expect(registrations).toHaveLength(3);
    expect(registrations.map((r) => r.name)).toEqual(["new", "help", "ask"]);
  });

  it("includes integration_types and contexts for global scope", () => {
    const registrations = getDiscordCommandRegistrations("global");

    for (const reg of registrations) {
      expect(reg.integration_types).toBeDefined();
      expect(reg.contexts).toBeDefined();
    }

    const newCmd = registrations.find((r) => r.name === "new");
    expect(newCmd?.integration_types).toEqual([0]);
    expect(newCmd?.contexts).toEqual([0, 1]);
  });

  it("omits integration_types and contexts for guild scope", () => {
    const registrations = getDiscordCommandRegistrations("guild");

    for (const reg of registrations) {
      expect(reg.integration_types).toBeUndefined();
      expect(reg.contexts).toBeUndefined();
    }
  });

  it("includes options when the discord command defines them", () => {
    const registrations = getDiscordCommandRegistrations();

    const askCmd = registrations.find((r) => r.name === "ask");
    expect(askCmd?.options).toBeDefined();
    expect(askCmd?.options).toHaveLength(1);
    expect(askCmd?.options?.[0]).toMatchObject({
      type: 3,
      name: "prompt",
      description: "What you want to ask",
      required: true,
    });

    const newCmd = registrations.find((r) => r.name === "new");
    expect(newCmd?.options).toBeUndefined();
  });

  it("uses default integration types and contexts when not specified", () => {
    const registrations = getDiscordCommandRegistrations("global");

    const helpCmd = registrations.find((r) => r.name === "help");
    expect(helpCmd?.integration_types).toEqual([0]);
    expect(helpCmd?.contexts).toEqual([0, 1]);
  });

  it("defaults to global scope when no scope is provided", () => {
    const globalRegistrations = getDiscordCommandRegistrations();
    const explicitGlobalRegistrations = getDiscordCommandRegistrations("global");

    expect(globalRegistrations).toEqual(explicitGlobalRegistrations);
  });
});

describe("clearConversation via /new command", () => {
  it("queries and deletes all conversation items across pagination", async () => {
    const sendMock = mock()
      .mockImplementationOnce(() =>
        Promise.resolve({
          Items: [
            { conversationKey: { S: "key-1" }, createdAt: { N: "1000" } },
            { conversationKey: { S: "key-1" }, createdAt: { N: "1001" } },
          ],
          LastEvaluatedKey: { conversationKey: { S: "key-1" }, createdAt: { N: "1001" } },
        }),
      )
      .mockImplementationOnce(() =>
        Promise.resolve({
          Items: [
            { conversationKey: { S: "key-1" }, createdAt: { N: "1002" } },
          ],
          LastEvaluatedKey: undefined,
        }),
      )
      .mockImplementation(() =>
        Promise.resolve({ UnprocessedItems: {} }),
      );

    dynamo.send = sendMock as never;

    const channel = createMockChannelActions();
    const ctx = createCommandContext({
      conversationKey: "key-1",
      conversationsTableName: "TestTable",
      channel,
    });

    await executeCommand("/new", ctx);

    expect(sendMock).toHaveBeenCalledTimes(3);

    const firstCall = sendMock.mock.calls[0]?.[0] as QueryCommand;
    expect(firstCall.input.TableName).toBe("TestTable");
    expect(firstCall.input.KeyConditionExpression).toBe("conversationKey = :conversationKey");

    expect(channel.sendText).toHaveBeenCalledWith("Context cleared. Starting fresh.");
  });

  it("handles empty query results gracefully", async () => {
    const sendMock = mock(() =>
      Promise.resolve({ Items: [], LastEvaluatedKey: undefined }),
    );

    dynamo.send = sendMock as never;

    const channel = createMockChannelActions();
    const ctx = createCommandContext({
      conversationKey: "empty-key",
      conversationsTableName: "TestTable",
      channel,
    });

    await executeCommand("/new", ctx);

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(channel.sendText).toHaveBeenCalledWith("Context cleared. Starting fresh.");
  });

  it("retries unprocessed batch write items", async () => {
    const sendMock = mock()
      .mockImplementationOnce(() =>
        Promise.resolve({
          Items: [
            { conversationKey: { S: "key-1" }, createdAt: { N: "1000" } },
            { conversationKey: { S: "key-1" }, createdAt: { N: "1001" } },
          ],
          LastEvaluatedKey: undefined,
        }),
      )
      .mockImplementationOnce(() =>
        Promise.resolve({
          UnprocessedItems: {
            TestTable: [
              { DeleteRequest: { Key: { conversationKey: { S: "key-1" }, createdAt: { N: "1001" } } } },
            ],
          },
        }),
      )
      .mockImplementationOnce(() =>
        Promise.resolve({ UnprocessedItems: {} }),
      );

    dynamo.send = sendMock as never;

    const channel = createMockChannelActions();
    const ctx = createCommandContext({
      conversationKey: "key-1",
      conversationsTableName: "TestTable",
      channel,
    });

    await executeCommand("/new", ctx);

    expect(sendMock).toHaveBeenCalledTimes(3);

    const batchCall = sendMock.mock.calls[1]?.[0] as BatchWriteItemCommand;
    expect(batchCall.input.RequestItems?.TestTable).toHaveLength(2);
  });

  it("deletes in chunks of 25 when query returns more than 25 items", async () => {
    const items = Array.from({ length: 60 }, (_, i) => ({
      conversationKey: { S: "key-1" },
      createdAt: { N: String(i) },
    }));

    const sendMock = mock()
      .mockImplementationOnce(() =>
        Promise.resolve({ Items: items, LastEvaluatedKey: undefined }),
      )
      .mockImplementation(() =>
        Promise.resolve({ UnprocessedItems: {} }),
      );

    dynamo.send = sendMock as never;

    const channel = createMockChannelActions();
    const ctx = createCommandContext({
      conversationKey: "key-1",
      conversationsTableName: "TestTable",
      channel,
    });

    await executeCommand("/new", ctx);

    expect(sendMock).toHaveBeenCalledTimes(4);

    const firstBatchCall = sendMock.mock.calls[1]?.[0] as BatchWriteItemCommand;
    expect(firstBatchCall.input.RequestItems?.TestTable).toHaveLength(25);

    const secondBatchCall = sendMock.mock.calls[2]?.[0] as BatchWriteItemCommand;
    expect(secondBatchCall.input.RequestItems?.TestTable).toHaveLength(25);

    const thirdBatchCall = sendMock.mock.calls[3]?.[0] as BatchWriteItemCommand;
    expect(thirdBatchCall.input.RequestItems?.TestTable).toHaveLength(10);
  });
});
