/**
 * Bot command tests.
 * Cover command parsing, execution, Discord resolution, and registration here.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { runtime } from "../src/shared/convex/runtime.ts";
import type { ChannelActions } from "../src/shared/channels.ts";
import {
  commands,
  executeCommand,
  getDiscordCommandRegistrations,
  parseCommand,
  resolveDiscordCommand,
} from "../src/shared/commands.ts";

const originalMutation = runtime.mutate;

beforeEach(() => {
  runtime.mutate = mock((name: string) =>
    Promise.resolve(
      name === "acquireIngressClear"
        ? 1
        : name === "clearFencedConversation"
          ? { deleted: 0, hasMore: false }
          : null,
    ),
  ) as never;
});

afterEach(() => {
  runtime.mutate = originalMutation;
  mock.restore();
});

function createMockChannelActions(
  overrides: Partial<ChannelActions> = {},
): ChannelActions {
  return {
    sendText: mock(async () => {}),
    sendTyping: mock(async () => {}),
    reactToMessage: mock(async () => {}),
    ...overrides,
  };
}

function createCommandContext(
  overrides: Partial<{
    conversationKey: string;
    channel: ChannelActions;
    accountId: string;
    agentId: string;
    eventId: string;
    text: string;
  }> = {},
) {
  return {
    conversationKey: overrides.conversationKey ?? "test-convo",
    channel: overrides.channel ?? createMockChannelActions(),
    accountId: overrides.accountId ?? "account-1",
    agentId: overrides.agentId ?? "agent-1",
    eventId: overrides.eventId ?? "event-1",
    text: overrides.text,
  };
}

describe("command definitions", () => {
  it("defines command handlers with expected aliases", () => {
    expect(commands).toHaveLength(4);

    const newCmd = commands.find((c) => c.aliases.includes("/new"));
    const helpCmd = commands.find((c) => c.aliases.includes("/help"));
    const steerCmd = commands.find((c) => c.aliases.includes("/steer"));
    const queueCmd = commands.find((c) => c.aliases.includes("/queue"));

    expect(newCmd).toBeDefined();
    expect(helpCmd).toBeDefined();
    expect(steerCmd).toBeDefined();
    expect(queueCmd).toBeDefined();
  });

  it("/new and /clear share the same handler", () => {
    const newCmd = commands.find((c) => c.aliases.includes("/new"));
    const clearCmd = commands.find((c) => c.aliases.includes("/clear"));

    expect(newCmd).toBe(clearCmd);
    expect(newCmd?.aliases).toEqual(["/new", "/clear"]);
  });

  it("all commands have discord metadata", () => {
    for (const cmd of commands) {
      expect(cmd.discord).toBeDefined();
      expect(cmd.discord?.names.length).toBeGreaterThan(0);
      expect(cmd.discord?.description).toBeTruthy();
    }
  });
});

describe("parseCommand", () => {
  it("returns the command token for valid executable commands", () => {
    expect(parseCommand("/new")).toBe("/new");
    expect(parseCommand("/clear")).toBe("/clear");
    expect(parseCommand("/help")).toBe("/help");
    expect(parseCommand("/steer change direction")).toBe("/steer");
    expect(parseCommand("/queue collect")).toBe("/queue");
  });

  it("normalizes case and trims whitespace", () => {
    expect(parseCommand("  /NEW  ")).toBe("/new");
    expect(parseCommand("/HELP")).toBe("/help");
    expect(parseCommand("\t/Clear\n")).toBe("/clear");
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

  it("returns null for unregistered commands", () => {
    expect(parseCommand("/query")).toBeNull();
    expect(parseCommand("/query what is 2+2")).toBeNull();
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

    expect(channel.sendText).toHaveBeenCalledWith(
      "Context cleared. Starting fresh.",
    );
  });

  it("executes /help and lists executable commands", async () => {
    const channel = createMockChannelActions();
    const ctx = createCommandContext({ channel });

    await executeCommand("/help", ctx);

    expect(channel.sendText).toHaveBeenCalledTimes(1);
    const helpText = (channel.sendText as ReturnType<typeof mock>).mock
      .calls[0]?.[0] as string;
    expect(helpText).toContain("Available commands:");
    expect(helpText).toContain("/new");
    expect(helpText).toContain("/clear");
    expect(helpText).toContain("/help");
    expect(helpText).not.toContain("/query");
  });

  it("persists a conversation queue preference", async () => {
    const mutationMock = mock(() => Promise.resolve("steer"));
    runtime.mutate = mutationMock as never;
    const channel = createMockChannelActions();
    await executeCommand(
      "/queue",
      createCommandContext({ channel, text: "/queue steer" }),
    );

    expect(mutationMock).toHaveBeenCalledWith("setIngressChannelMode", {
      accountId: "account-1",
      agentId: "agent-1",
      conversationKey: "test-convo",
      mode: "steer",
    });
    expect(channel.sendText).toHaveBeenCalledWith("Queue mode set to steer.");
  });

  it("does nothing for unknown command tokens", async () => {
    const channel = createMockChannelActions();
    const ctx = createCommandContext({ channel });

    await executeCommand("/query", ctx);

    expect(channel.sendText).not.toHaveBeenCalled();
  });

  it("also ignores bogus command tokens", async () => {
    const channel = createMockChannelActions();
    const ctx = createCommandContext({ channel });

    await executeCommand("/bogus", ctx);

    expect(channel.sendText).not.toHaveBeenCalled();
  });

  it("sends a generic error message when command execution fails", async () => {
    const channel = createMockChannelActions();
    const ctx = createCommandContext({ channel });

    runtime.mutate = mock(() =>
      Promise.reject(new Error("Convex connection failed")),
    ) as never;

    await executeCommand("/new", ctx);

    expect(channel.sendText).toHaveBeenCalledWith(
      "Something went wrong. Please try again.",
    );
  });

  it("handles non-Error exceptions during execution", async () => {
    const channel = createMockChannelActions();
    const ctx = createCommandContext({ channel });

    runtime.mutate = mock(() => Promise.reject("string error")) as never;

    await executeCommand("/new", ctx);

    expect(channel.sendText).toHaveBeenCalledWith(
      "Something went wrong. Please try again.",
    );
  });
});

describe("resolveDiscordCommand", () => {
  it("resolves a standard discord command with a command token", () => {
    const result = resolveDiscordCommand("new", "");

    expect(result).not.toBeNull();
    expect(result?.commandToken).toBe("/new");
    expect(result?.contentText).toBe("");
  });

  it("resolves the Discord clear alias with the same command token", () => {
    const result = resolveDiscordCommand("clear", "");

    expect(result).not.toBeNull();
    expect(result?.commandToken).toBe("/new");
    expect(result?.contentText).toBe("");
  });

  it("returns null for unknown discord command names", () => {
    expect(resolveDiscordCommand("unknown", "")).toBeNull();
    expect(resolveDiscordCommand("query", "what is the weather?")).toBeNull();
    expect(resolveDiscordCommand("help", "")).not.toBeNull();
  });

  it("preserves command token for commands with option text", () => {
    const result = resolveDiscordCommand("help", "extra text");

    expect(result?.commandToken).toBe("/help");
    expect(result?.contentText).toBe("extra text");
  });
});

describe("getDiscordCommandRegistrations", () => {
  it("returns registrations for all commands with discord metadata", () => {
    const registrations = getDiscordCommandRegistrations();

    expect(registrations).toHaveLength(5);
    expect(registrations.map((r) => r.name)).toEqual([
      "new",
      "clear",
      "steer",
      "queue",
      "help",
    ]);
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

  it("registers options only for commands that accept arguments", () => {
    const registrations = getDiscordCommandRegistrations();

    expect(
      registrations.find((r) => r.name === "new")?.options,
    ).toBeUndefined();
    expect(registrations.find((r) => r.name === "steer")?.options).toHaveLength(
      1,
    );
    expect(registrations.find((r) => r.name === "queue")?.options).toHaveLength(
      1,
    );
  });

  it("uses default integration types and contexts when not specified", () => {
    const registrations = getDiscordCommandRegistrations("global");

    const helpCmd = registrations.find((r) => r.name === "help");
    expect(helpCmd?.integration_types).toEqual([0]);
    expect(helpCmd?.contexts).toEqual([0, 1]);
  });

  it("defaults to global scope when no scope is provided", () => {
    const globalRegistrations = getDiscordCommandRegistrations();
    const explicitGlobalRegistrations =
      getDiscordCommandRegistrations("global");

    expect(globalRegistrations).toEqual(explicitGlobalRegistrations);
  });
});

describe("clearConversation via /new command", () => {
  it("repeats bounded Convex deletes until the conversation is empty", async () => {
    let clearCalls = 0;
    const mutationMock = mock((name: string) => {
      if (name === "acquireIngressClear") return Promise.resolve(7);
      if (name === "clearFencedConversation") {
        clearCalls += 1;
        return Promise.resolve(
          clearCalls === 1
            ? { deleted: 100, hasMore: true }
            : { deleted: 2, hasMore: false },
        );
      }
      return Promise.resolve(null);
    });
    runtime.mutate = mutationMock as never;
    const channel = createMockChannelActions();
    await executeCommand(
      "/new",
      createCommandContext({ conversationKey: "key-1", channel }),
    );
    expect(mutationMock).toHaveBeenCalledTimes(4);
    expect(mutationMock).toHaveBeenCalledWith("clearFencedConversation", {
      conversationKey: "key-1",
      ownerEventId: "event-1",
      ownerGeneration: 7,
    });
    expect(channel.sendText).toHaveBeenCalledWith(
      "Context cleared. Starting fresh.",
    );
  });

  it("reports success when the final allowed batch completes cleanup", async () => {
    let calls = 0;
    const mutationMock = mock((name: string) => {
      if (name === "acquireIngressClear") return Promise.resolve(1);
      if (name === "clearFencedConversation") {
        calls += 1;
        return Promise.resolve({ deleted: 100, hasMore: calls < 100 });
      }
      return Promise.resolve(null);
    });
    runtime.mutate = mutationMock as never;
    const channel = createMockChannelActions();

    await executeCommand(
      "/new",
      createCommandContext({ conversationKey: "key-1", channel }),
    );
    expect(mutationMock).toHaveBeenCalledTimes(102);
    expect(channel.sendText).toHaveBeenCalledWith(
      "Context cleared. Starting fresh.",
    );
    expect(channel.sendText).not.toHaveBeenCalledWith(
      "Something went wrong. Please try again.",
    );
  });

  it("returns an error when conversation cleanup does not converge", async () => {
    const mutationMock = mock((name: string) =>
      Promise.resolve(
        name === "acquireIngressClear"
          ? 1
          : name === "clearFencedConversation"
            ? { deleted: 100, hasMore: true }
            : null,
      ),
    );
    runtime.mutate = mutationMock as never;
    const channel = createMockChannelActions();

    await executeCommand(
      "/new",
      createCommandContext({ conversationKey: "key-1", channel }),
    );
    expect(mutationMock).toHaveBeenCalledTimes(102);
    expect(channel.sendText).toHaveBeenCalledWith(
      "Something went wrong. Please try again.",
    );
    expect(channel.sendText).not.toHaveBeenCalledWith(
      "Context cleared. Starting fresh.",
    );
  });
});
