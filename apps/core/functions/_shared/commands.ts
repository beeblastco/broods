/**
 * Shared bot commands.
 * Keep channel-agnostic command logic here.
 */

import {
  BatchWriteItemCommand,
  QueryCommand,
  type AttributeValue,
  type WriteRequest,
} from "@aws-sdk/client-dynamodb";
import type { ChannelActions } from "./channels.ts";
import { dynamo } from "./storage/dynamo/client.ts";
import { logError } from "./log.ts";

export interface CommandContext {
  conversationKey: string;
  conversationsTableName: string;
  channel: ChannelActions;
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

export const commands: CommandHandler[] = [
  {
    aliases: ["/new", "/clear"],
    description: "Clear conversation context and start fresh",
    discord: {
      names: ["new", "clear"],
      description: "Clear conversation context and start fresh",
    },
    async execute(ctx) {
      await clearConversation(ctx.conversationKey, ctx.conversationsTableName);
      return "Context cleared. Starting fresh.";
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
  const handler = getExecutableCommands().find((c) => c.aliases.includes(commandToken));
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
  const handler = commands.find((command) => command.discord?.names.includes(name));
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
          integration_types: discord.integrationTypes ?? DEFAULT_DISCORD_INTEGRATION_TYPES,
          contexts: discord.contexts ?? DEFAULT_DISCORD_CONTEXTS,
        }
        : {}),
    }));
  });
}

function getExecutableCommands(): Array<CommandHandler & { execute: NonNullable<CommandHandler["execute"]> }> {
  return commands.filter(
    (command): command is CommandHandler & { execute: NonNullable<CommandHandler["execute"]> } =>
      typeof command.execute === "function",
  );
}

async function clearConversation(
  conversationKey: string,
  tableName: string,
): Promise<void> {
  let exclusiveStartKey: Record<string, AttributeValue> | undefined;

  do {
    const page = await dynamo.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "conversationKey = :conversationKey",
        ExpressionAttributeValues: {
          ":conversationKey": { S: conversationKey },
        },
        ProjectionExpression: "conversationKey, createdAt",
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );

    const items = page.Items ?? [];
    for (let index = 0; index < items.length; index += 25) {
      await deleteConversationChunk(tableName, items.slice(index, index + 25));
    }

    exclusiveStartKey = page.LastEvaluatedKey;
  } while (exclusiveStartKey);
}

async function deleteConversationChunk(
  tableName: string,
  items: Record<string, AttributeValue>[],
): Promise<void> {
  let pending: WriteRequest[] = items.map((item) => ({
    DeleteRequest: {
      Key: {
        conversationKey: item.conversationKey!,
        createdAt: item.createdAt!,
      },
    },
  }));

  while (pending.length > 0) {
    const result = await dynamo.send(
      new BatchWriteItemCommand({
        RequestItems: {
          [tableName]: pending,
        },
      }),
    );

    pending = result.UnprocessedItems?.[tableName] ?? [];
  }
}
