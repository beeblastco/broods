/**
 * Shared bot commands.
 * Keep channel-agnostic command logic here.
 */

import type { ChannelActions } from "./channels.ts";
import { runtime } from "./convex/runtime.ts";
import { logError } from "./log.ts";

export interface CommandContext {
  conversationKey: string;
  channel: ChannelActions;
  accountId?: string;
  agentId?: string;
  eventId?: string;
  text?: string;
}

interface DiscordCommandOption {
  type: number;
  name: string;
  description: string;
  required?: boolean;
}

interface DiscordCommandMetadata {
  names: string[];
  description: string;
  options?: DiscordCommandOption[];
  integrationTypes?: number[];
  contexts?: number[];
}

interface CommandHandler {
  aliases: string[];
  description: string;
  execute?: (ctx: CommandContext) => Promise<string>;
  discord?: DiscordCommandMetadata;
  showInHelp?: boolean;
}

export interface DiscordCommandRegistration {
  name: string;
  description: string;
  options?: DiscordCommandOption[];
  integration_types?: number[];
  contexts?: number[];
}

export interface DiscordCommandResolution {
  contentText: string;
  commandToken?: string;
}

const DEFAULT_DISCORD_INTEGRATION_TYPES = [0];
const DEFAULT_DISCORD_CONTEXTS = [0, 1];
const CLEAR_CONVERSATION_MAX_BATCHES = 100;

export const commands: CommandHandler[] = [
  {
    aliases: ["/new", "/clear"],
    description: "Clear conversation context and start fresh",
    discord: {
      names: ["new", "clear"],
      description: "Clear conversation context and start fresh",
    },
    async execute(ctx) {
      if (!ctx.accountId || !ctx.agentId || !ctx.eventId) {
        throw new Error("Clear requires account, agent, and event scope");
      }
      const ownerGeneration = await runtime.mutate<number | null>(
        "acquireIngressClear",
        {
          accountId: ctx.accountId,
          agentId: ctx.agentId,
          conversationKey: ctx.conversationKey,
          ownerEventId: ctx.eventId,
          leaseTtlMs: 15 * 60 * 1000,
        },
      );
      if (ownerGeneration === null) {
        return "Cannot clear while a turn or queued message is active. Try again after it finishes.";
      }
      try {
        for (
          let batchNumber = 0;
          batchNumber < CLEAR_CONVERSATION_MAX_BATCHES;
          batchNumber += 1
        ) {
          const result = await runtime.mutate<{
            deleted: number;
            hasMore: boolean;
          }>("clearFencedConversation", {
            conversationKey: ctx.conversationKey,
            ownerEventId: ctx.eventId,
            ownerGeneration: ownerGeneration,
          });
          if (!result.hasMore) return "Context cleared. Starting fresh.";
        }

        return `Conversation cleanup exceeded ${CLEAR_CONVERSATION_MAX_BATCHES} Convex batches; run /clear again to continue`;
      } finally {
        await runtime.mutate("releaseIngressOwner", {
          conversationKey: ctx.conversationKey,
          ownerEventId: ctx.eventId,
          ownerGeneration: ownerGeneration,
        });
      }
    },
  },
  {
    aliases: ["/steer"],
    description: "Steer the active turn at the next model boundary",
    discord: {
      names: ["steer"],
      description: "Steer the active turn at the next model boundary",
      options: [
        {
          type: 3,
          name: "text",
          description: "Guidance for the active turn",
          required: true,
        },
      ],
    },
    async execute() {
      return "Usage: /steer <message>";
    },
  },
  {
    aliases: ["/stop", "/cancel"],
    description: "Stop the active run at the next model boundary",
    discord: {
      names: ["stop"],
      description: "Stop the active run",
    },
    async execute(ctx) {
      if (!ctx.accountId || !ctx.agentId) {
        throw new Error("Stop requires account and agent scope");
      }
      const result = await runtime.mutate<{
        stopped: boolean;
        queuedCount: number;
      }>("stopIngressOwner", {
        accountId: ctx.accountId,
        agentId: ctx.agentId,
        conversationKey: ctx.conversationKey,
      });
      if (!result.stopped) return "Nothing is running right now.";

      return result.queuedCount > 0
        ? `Stopping at the next model boundary. ${result.queuedCount} queued message(s) will continue afterward.`
        : "Stopping at the next model boundary.";
    },
  },
  {
    aliases: ["/queue"],
    description: "Queue one message as an explicit follow-up",
    discord: {
      names: ["queue"],
      description: "Queue a follow-up message",
      options: [
        {
          type: 3,
          name: "text",
          description: "Message to run after the active turn",
          required: true,
        },
      ],
    },
    async execute() {
      return "Usage: /queue <message>";
    },
  },
  {
    aliases: ["/help"],
    description: "Show available commands",
    discord: {
      names: ["help"],
      description: "Show available commands",
    },
    async execute() {
      const lines = ["Available commands:"];
      for (const cmd of getExecutableCommands()) {
        if (cmd.showInHelp === false) {
          continue;
        }
        lines.push(`${cmd.aliases.join(", ")} — ${cmd.description}`);
      }
      return lines.join("\n");
    },
  },
];

export function parseCommand(text: string): string | null {
  const token = text.trim().toLowerCase().split(/\s+/)[0] ?? "";
  if (!token.startsWith("/")) return null;
  const match = getExecutableCommands().find((c) => c.aliases.includes(token));
  return match ? token : null;
}

export async function executeCommand(
  commandToken: string,
  ctx: CommandContext,
): Promise<void> {
  const handler = getExecutableCommands().find((c) =>
    c.aliases.includes(commandToken),
  );
  if (!handler?.execute) return;

  try {
    const reply = await handler.execute(ctx);
    await ctx.channel.sendText(reply);
  } catch (err) {
    logError("Command execution failed", {
      command: commandToken,
      error: err instanceof Error ? err.message : String(err),
    });
    await ctx.channel.sendText("Something went wrong. Please try again.");
  }
}

export function resolveDiscordCommand(
  name: string,
  optionText: string,
): DiscordCommandResolution | null {
  const handler = commands.find((command) =>
    command.discord?.names.includes(name),
  );
  if (!handler?.discord) {
    return null;
  }

  return {
    contentText: optionText.trim(),
    commandToken: handler.aliases[0],
  };
}

export function getDiscordCommandRegistrations(
  scope: "global" | "guild" = "global",
): DiscordCommandRegistration[] {
  return commands.flatMap((command) => {
    const discord = command.discord;
    if (!discord) {
      return [];
    }

    return discord.names.map((name) => ({
      name,
      description: discord.description,
      ...(discord.options ? { options: discord.options } : {}),
      ...(scope === "global"
        ? {
            integration_types:
              discord.integrationTypes ?? DEFAULT_DISCORD_INTEGRATION_TYPES,
            contexts: discord.contexts ?? DEFAULT_DISCORD_CONTEXTS,
          }
        : {}),
    }));
  });
}

function getExecutableCommands(): Array<
  CommandHandler & { execute: NonNullable<CommandHandler["execute"]> }
> {
  return commands.filter(
    (
      command,
    ): command is CommandHandler & {
      execute: NonNullable<CommandHandler["execute"]>;
    } => typeof command.execute === "function",
  );
}
