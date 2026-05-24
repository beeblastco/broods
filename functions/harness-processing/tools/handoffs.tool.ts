/**
 * Human handoff tool.
 * Keep provider-specific handoff actions here; webhook parsing stays in _shared.
 */

import { jsonSchema, tool, type ToolSet } from "ai";
import type { AgentChannelsConfig } from "../../_shared/storage/index.ts";
import type { ToolContext } from "./index.ts";

interface HandoffsToolContext extends ToolContext {
  channels?: AgentChannelsConfig;
}

export default function handoffsTool(context: HandoffsToolContext): ToolSet {
  return {
    handoffs: tool({
      description: "Hand off the current customer conversation to human staff.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          reason: {
            type: "string",
            description: "Optional short reason for the handoff.",
          },
        },
        additionalProperties: false,
      }),
      execute: async () => {
        const conversation = parsePancakeConversationKey(context.conversationKey);
        const pageAccessToken = resolvePageAccessToken(context);
        const tagId = resolveHandoffTagId(context);

        const url = new URL(
          `https://pages.fm/api/public_api/v1/pages/${encodeURIComponent(conversation.pageId)}/conversations/${
            encodeURIComponent(conversation.conversationId)
          }/tags`,
        );
        url.searchParams.set("page_access_token", pageAccessToken);

        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "add",
            tag_id: tagId,
          }),
        });
        const bodyText = await response.text();
        const body = parseJsonBody(bodyText);

        if (!response.ok || body?.success === false) {
          throw new Error(`Pancake handoff failed (${response.status}): ${formatPancakeError(body, bodyText)}`);
        }

        return {
          type: "text",
          value: "Conversation handed off to human staff.",
        };
      },
    }),
  };
}

function resolvePageAccessToken(context: HandoffsToolContext): string {
  return firstNonEmptyString(
    context.channels?.pancake?.pageAccessToken,
  ) ?? missingConfig("config.channels.pancake.pageAccessToken");
}

function resolveHandoffTagId(context: HandoffsToolContext): string {
  return firstNonEmptyString(
    configuredHandoffTagId(context.channels),
  ) ?? missingConfig("config.channels.pancake.options.handoff.tagId");
}

function configuredHandoffTagId(channels: HandoffsToolContext["channels"]): unknown {
  const handoff = channels?.pancake?.options?.handoff;
  if (!handoff || typeof handoff !== "object" || Array.isArray(handoff)) {
    return undefined;
  }
  return (handoff as Record<string, unknown>).tagId;
}

function parsePancakeConversationKey(conversationKey: string): { pageId: string; conversationId: string } {
  const marker = "pancake:";
  const markerIndex = conversationKey.indexOf(marker);
  if (markerIndex === -1) {
    throw new Error("handoffs requires a Pancake conversation");
  }

  const value = conversationKey.slice(markerIndex + marker.length);
  const separatorIndex = value.indexOf(":");
  if (separatorIndex <= 0 || separatorIndex === value.length - 1) {
    throw new Error("Pancake page id or conversation id is missing from conversationKey");
  }

  return {
    pageId: value.slice(0, separatorIndex),
    conversationId: value.slice(separatorIndex + 1),
  };
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

function missingConfig(name: string): never {
  throw new Error(`${name} is required`);
}

function parseJsonBody(text: string): { success?: boolean; message?: string } | null {
  if (!text) {
    return null;
  }

  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" ? parsed as { success?: boolean; message?: string } : null;
  } catch {
    return null;
  }
}

function formatPancakeError(body: { message?: string } | null, bodyText: string): string {
  return body?.message ?? (bodyText || "unknown_error");
}
