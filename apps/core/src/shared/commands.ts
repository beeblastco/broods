/**
 * Shared bot commands.
 * Keep channel-agnostic command logic here.
 */

import type { UserContent } from "ai";
import { extractText, type ChannelActions } from "./channels.ts";
import { runtime } from "./convex/runtime.ts";
import { logError } from "./log.ts";

type ChannelCommandMode = "steer" | "followup";

export interface CommandContext {
  conversationKey: string;
  channel: ChannelActions;
  accountId?: string;
  agentId?: string;
  eventId?: string;
  text?: string;
  // Harness-injected: compacts the stored conversation under the given fenced
  // lease and resolves with how many messages were summarized (0 = nothing).
  // Commands stay channel-agnostic and never import harness modules.
  compact?: (options: {
    ownerGeneration: number;
    instructions: string;
  }) => Promise<number>;
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
  // Set when the command rewrites the ingress text instead of replying; the
  // value is the mode it requests. `execute` then serves only the bare usage.
  rewriteMode?: ChannelCommandMode;
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

// How an inbound channel command routes: rewrite the ingress text and continue
// to admission, reply via executeCommand, or pass through untouched.
export type ChannelCommandOutcome =
  | { kind: "rewrite"; text: string; requestedMode: ChannelCommandMode }
  | { kind: "reply"; commandToken: string }
  | { kind: "passthrough" };

const DEFAULT_DISCORD_INTEGRATION_TYPES = [0];
const DEFAULT_DISCORD_CONTEXTS = [0, 1];
const CLEAR_CONVERSATION_MAX_BATCHES = 100;
const INGRESS_CLEAR_LEASE_TTL_MS = 15 * 60 * 1000;

export const commands: CommandHandler[] = [
  {
    aliases: ["/new", "/clear"],
    description: "Clear conversation context and start fresh",
    discord: {
      names: ["new", "clear"],
      description: "Clear conversation context and start fresh",
    },
    execute: async function (ctx) {
      return withIngressClearLease(ctx, "clear", async (ownerGeneration) => {
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
      });
    },
  },
  {
    aliases: ["/compact"],
    description: "Compact conversation context into a summary",
    discord: {
      names: ["compact"],
      description: "Compact conversation context into a summary",
      options: [
        {
          type: 3,
          name: "instructions",
          description: "What the summary should focus on",
          required: false,
        },
      ],
    },
    execute: async function (ctx) {
      const compact = ctx.compact;
      if (!compact) {
        throw new Error("Compact requires the harness compact capability");
      }
      const instructions = stripCommandToken(ctx.text ?? "", "/compact");

      return withIngressClearLease(ctx, "compact", async (ownerGeneration) => {
        const compactedMessageCount = await compact({
          ownerGeneration: ownerGeneration,
          instructions: instructions,
        });

        return compactedMessageCount > 0
          ? `Context compacted. ${compactedMessageCount} message(s) summarized.`
          : "Nothing to compact yet.";
      });
    },
  },
  {
    aliases: ["/steer"],
    description: "Steer the active turn at the next model boundary",
    rewriteMode: "steer",
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
    execute: async function () {
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
    execute: async function (ctx) {
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
    rewriteMode: "followup",
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
    execute: async function () {
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
    execute: async function () {
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

export function resolveChannelCommand({
  content,
  commandToken,
}: {
  content: UserContent;
  commandToken?: string;
}): ChannelCommandOutcome {
  if (!commandToken) return { kind: "passthrough" };
  const requestedMode = commands.find((c) =>
    c.aliases.includes(commandToken),
  )?.rewriteMode;
  if (!requestedMode) return { kind: "reply", commandToken: commandToken };

  // A bare rewrite command carries no message, so it falls back to its usage reply.
  const text = stripCommandToken(extractText(content), commandToken);

  return text
    ? { kind: "rewrite", text: text, requestedMode: requestedMode }
    : { kind: "reply", commandToken: commandToken };
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
      name: name,
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

// Message text after a leading channel command token ("/steer", "/queue").
// Trim first: parseCommand ignores leading whitespace, so the token can be indented.
function stripCommandToken(content: string, token: string): string {
  return content.trim().replace(new RegExp(`^${token}(?:\\s+|$)`, "i"), "");
}

// Runs a command body under the fenced clear lease: acquired only while no run
// or queued ingress exists, released when the body settles.
async function withIngressClearLease(
  ctx: CommandContext,
  verb: string,
  run: (ownerGeneration: number) => Promise<string>,
): Promise<string> {
  if (!ctx.accountId || !ctx.agentId || !ctx.eventId) {
    throw new Error(`${verb} requires account, agent, and event scope`);
  }
  const ownerGeneration = await runtime.mutate<number | null>(
    "acquireIngressClear",
    {
      accountId: ctx.accountId,
      agentId: ctx.agentId,
      conversationKey: ctx.conversationKey,
      ownerEventId: ctx.eventId,
      leaseTtlMs: INGRESS_CLEAR_LEASE_TTL_MS,
    },
  );
  if (ownerGeneration === null) {
    return `Cannot ${verb} while a turn or queued message is active. Try again after it finishes.`;
  }
  try {
    return await run(ownerGeneration);
  } finally {
    await runtime.mutate("releaseIngressOwner", {
      conversationKey: ctx.conversationKey,
      ownerEventId: ctx.eventId,
      ownerGeneration: ownerGeneration,
    });
  }
}
