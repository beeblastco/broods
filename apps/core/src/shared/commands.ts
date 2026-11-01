import type { ModelMessage, UserContent } from "ai";
import {
  extractText,
  supportsInlineCommands,
  type ChannelActions,
} from "./channels.ts";
import { runtime } from "./convex/runtime.ts";
import { logError } from "./log.ts";

type ChannelCommandMode = "steer" | "followup";

export interface CommandContext {
  conversationKey: string;
  // Absent on an API run, whose reply rides the run's own result.
  channel?: ChannelActions;
  accountId?: string;
  agentId?: string;
  eventId?: string;
  text?: string;
  // Injected so commands never import harness modules; resolves with the summarized count.
  compact?: (instructions: string) => Promise<number>;
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
  // Rewrites the ingress text in this mode; `execute` then only answers a bare command.
  rewriteMode?: ChannelCommandMode;
  // Waits in the queue like a follow-up; the drain loop runs `execute` under its own lease.
  queued?: boolean;
}

export interface QueuedCommand {
  commandToken: string;
  text: string;
}

export interface CommandResult {
  reply: string;
  error?: string;
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
      return withIngressClearLease(
        ctx,
        "clear",
        async (ownerEventId, ownerGeneration) => {
          for (
            let batchNumber = 0;
            batchNumber < CLEAR_CONVERSATION_MAX_BATCHES;
            batchNumber += 1
          ) {
            const result = await runtime.mutate("clearFencedConversation", {
              conversationKey: ctx.conversationKey,
              ownerEventId: ownerEventId,
              ownerGeneration: ownerGeneration,
            });
            if (!result.hasMore) return "Context cleared. Starting fresh.";
          }

          return `Conversation cleanup exceeded ${CLEAR_CONVERSATION_MAX_BATCHES} Convex batches; run /clear again to continue`;
        },
      );
    },
  },
  {
    aliases: ["/compact"],
    description: "Compact conversation context into a summary",
    queued: true,
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
      const compactedMessageCount = await compact(
        stripCommandToken(ctx.text ?? "", "/compact"),
      );

      return compactedMessageCount > 0
        ? `Context compacted. ${compactedMessageCount} message(s) summarized.`
        : "Nothing to compact yet.";
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
      const result = await runtime.mutate("stopIngressOwner", {
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
        lines.push(`${cmd.aliases.join(", ")}: ${cmd.description}`);
      }

      return lines.join("\n");
    },
  },
];

export async function executeCommand(
  commandToken: string,
  ctx: CommandContext,
): Promise<CommandResult | undefined> {
  const handler = getExecutableCommands().find((c) =>
    c.aliases.includes(commandToken),
  );
  if (!handler?.execute) return undefined;

  let result: CommandResult;
  try {
    result = { reply: await handler.execute(ctx) };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logError("Command execution failed", {
      command: commandToken,
      error: error,
    });
    result = { reply: "Something went wrong. Please try again.", error: error };
  }
  await ctx.channel?.sendText(result.reply);

  return result;
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

export function parseCommand(text: string): string | null {
  const token = text.trim().toLowerCase().split(/\s+/)[0] ?? "";
  if (!token.startsWith("/")) return null;
  const match = getExecutableCommands().find((c) => c.aliases.includes(token));

  return match ? token : null;
}

export function queuedCommand(
  events: readonly ModelMessage[],
  channelName?: string,
): QueuedCommand | undefined {
  if (channelName !== undefined && !supportsInlineCommands(channelName)) {
    return undefined;
  }
  const turn = events.filter((event) => event.role !== "system");
  const event = turn.length === 1 ? turn[0] : undefined;
  // Only text: a file or image sent with the command would be dropped with it.
  if (
    event?.role !== "user" ||
    (typeof event.content !== "string" &&
      !event.content.every((part) => part.type === "text"))
  ) {
    return undefined;
  }
  const text = extractText(event.content).trim();
  const commandToken = parseCommand(text);
  if (
    !commandToken ||
    !commands.some((c) => c.queued && c.aliases.includes(commandToken))
  ) {
    return undefined;
  }

  return { commandToken: commandToken, text: text };
}

export function resolveChannelCommand({
  content,
  commandToken,
}: {
  content: UserContent;
  commandToken?: string;
}): ChannelCommandOutcome {
  if (!commandToken) return { kind: "passthrough" };
  const handler = commands.find((c) => c.aliases.includes(commandToken));
  // Admitted as a follow-up with its token kept, so the drain loop finds it.
  if (handler?.queued) {
    const text = stripCommandToken(extractText(content), commandToken);

    return {
      kind: "rewrite",
      text: `${commandToken} ${text}`.trim(),
      requestedMode: "followup",
    };
  }
  const requestedMode = handler?.rewriteMode;
  if (!requestedMode) return { kind: "reply", commandToken: commandToken };

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

// Trim first: parseCommand ignores leading whitespace, so the token can be indented.
function stripCommandToken(content: string, token: string): string {
  return content.trim().replace(new RegExp(`^${token}(?:\\s+|$)`, "i"), "");
}

async function withIngressClearLease(
  ctx: CommandContext,
  verb: string,
  run: (ownerEventId: string, ownerGeneration: number) => Promise<string>,
): Promise<string> {
  if (!ctx.accountId || !ctx.agentId || !ctx.eventId) {
    throw new Error(`${verb} requires account, agent, and event scope`);
  }
  const ownerGeneration = await runtime.mutate("acquireIngressClear", {
    accountId: ctx.accountId,
    agentId: ctx.agentId,
    conversationKey: ctx.conversationKey,
    ownerEventId: ctx.eventId,
    leaseTtlMs: INGRESS_CLEAR_LEASE_TTL_MS,
  });
  if (ownerGeneration === null) {
    return `Cannot ${verb} while a turn or queued message is active. Try again after it finishes.`;
  }
  try {
    return await run(ctx.eventId, ownerGeneration);
  } finally {
    await runtime.mutate("releaseIngressOwner", {
      conversationKey: ctx.conversationKey,
      ownerEventId: ctx.eventId,
      ownerGeneration: ownerGeneration,
    });
  }
}
