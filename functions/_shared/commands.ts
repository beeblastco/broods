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
import { dynamo } from "./dynamo.ts";
import { logError } from "./log.ts";

export interface CommandContext {
  conversationKey: string;
  conversationsTableName: string;
  channel: ChannelActions;
}

interface CommandHandler {
  aliases: string[];
  description: string;
  execute(ctx: CommandContext): Promise<string>;
}

const commands: CommandHandler[] = [
  {
    aliases: ["/new", "/start"],
    description: "Clear conversation context and start fresh",
    async execute(ctx) {
      await clearConversation(ctx.conversationKey, ctx.conversationsTableName);
      return "Context cleared. Starting fresh.";
    },
  },
  {
    aliases: ["/help"],
    description: "Show available commands",
    async execute() {
      const lines = ["Available commands:"];
      for (const cmd of commands) {
        lines.push(`${cmd.aliases[0]} — ${cmd.description}`);
      }
      return lines.join("\n");
    },
  },
];

export function parseCommand(text: string): string | null {
  const token = text.trim().toLowerCase().split(/\s+/)[0] ?? "";
  if (!token.startsWith("/")) return null;
  const match = commands.find((c) => c.aliases.includes(token));
  return match ? token : null;
}

export async function executeCommand(
  commandToken: string,
  ctx: CommandContext,
): Promise<void> {
  const handler = commands.find((c) => c.aliases.includes(commandToken));
  if (!handler) return;

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
