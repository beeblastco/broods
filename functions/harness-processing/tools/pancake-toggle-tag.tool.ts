/**
 * Pancake tag mutation tool.
 * Keep Pancake conversation tag changes here; webhook parsing stays in _shared.
 */

import { jsonSchema, tool, type ToolSet } from "ai";
import type { ToolContext } from "./index.ts";

type PancakeTagAction = "add" | "remove";

export default function pancakeToggleTagTool(context: ToolContext): ToolSet {
  return {
    pancake_toggle_tag: tool({
      description:
        "Add or remove a Pancake conversation tag on the current Pancake conversation. Use action add with the default configured handoff tag when human staff should take over.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["add", "remove"],
            description: "Whether to add or remove the tag.",
          },
          tagId: {
            type: "string",
            description: "Optional Pancake tag ID. Defaults to channels.pancake.options.handoff.tagId.",
          },
        },
        required: ["action"],
        additionalProperties: false,
      }),
      execute: async (input) => {
        const action = normalizeAction(input);
        const conversation = parsePancakeConversationKey(context.conversationKey);
        const pageAccessToken = resolvePageAccessToken(context);
        const tagId = resolveTagId(context, input);

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
            action,
            tag_id: tagId,
          }),
        });
        const bodyText = await response.text();
        const body = parseJsonBody(bodyText);

        if (!response.ok || body?.success === false) {
          throw new Error(`Pancake tag update failed (${response.status}): ${formatPancakeError(body, bodyText)}`);
        }

        return {
          type: "text",
          value: `Pancake tag ${tagId} ${action === "add" ? "added to" : "removed from"} conversation ${conversation.conversationId}.`,
        };
      },
    }),
  };
}

function normalizeAction(input: unknown): PancakeTagAction {
  const action = (input as { action?: unknown })?.action;
  if (action !== "add" && action !== "remove") {
    throw new Error("action must be add or remove");
  }
  return action;
}

function resolvePageAccessToken(context: ToolContext): string {
  return firstNonEmptyString(
    context.channels?.pancake?.pageAccessToken,
  ) ?? missingConfig("config.channels.pancake.pageAccessToken");
}

function resolveTagId(context: ToolContext, input: unknown): string {
  return firstNonEmptyString(
    (input as { tagId?: unknown })?.tagId,
    configuredHandoffTagId(context.channels),
  ) ?? missingConfig("tagId or config.channels.pancake.options.handoff.tagId");
}

function configuredHandoffTagId(channels: ToolContext["channels"]): unknown {
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
    throw new Error("pancake_toggle_tag requires a Pancake conversation");
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
