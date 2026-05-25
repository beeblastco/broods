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

interface PancakeActionResponse {
  success?: boolean;
  message?: string;
  data?: unknown;
}

interface HandoffToolResponse {
  success: boolean;
  message: string;
  actions: {
    tag: PancakeActionResponse | null;
    unread: PancakeActionResponse | null;
  };
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

        const tag = await addHandoffTag(conversation, pageAccessToken, tagId);
        const unread = await markConversationUnread(conversation, pageAccessToken);

        return toHandoffToolResponse(tag, unread);
      },
    }),
  };
}

async function addHandoffTag(
  conversation: { pageId: string; conversationId: string },
  pageAccessToken: string,
  tagId: string,
): Promise<PancakeActionResponse | null> {
  const response = await postPancakeConversationAction(conversation, pageAccessToken, "tags", "Pancake handoff failed", {
    action: "add",
    tag_id: tagId,
  });
  assertTagApplied(response, tagId);
  return response;
}

async function markConversationUnread(
  conversation: { pageId: string; conversationId: string },
  pageAccessToken: string,
): Promise<PancakeActionResponse | null> {
  return await postPancakeConversationAction(conversation, pageAccessToken, "unread", "Pancake unread failed");
}

async function postPancakeConversationAction(
  conversation: { pageId: string; conversationId: string },
  pageAccessToken: string,
  actionPath: "tags" | "unread",
  errorPrefix: string,
  body?: Record<string, unknown>,
): Promise<PancakeActionResponse | null> {
  const url = new URL(
    `https://pages.fm/api/public_api/v1/pages/${encodeURIComponent(conversation.pageId)}/conversations/${
      encodeURIComponent(conversation.conversationId)
    }/${actionPath}`,
  );
  url.searchParams.set("page_access_token", pageAccessToken);

  const response = await fetch(url, {
    method: "POST",
    ...(body
      ? {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
      : {}),
  });
  const bodyText = await response.text();
  const parsedBody = parseJsonBody(bodyText);

  if (!response.ok || parsedBody?.success === false) {
    throw new Error(`${errorPrefix} (${response.status}): ${formatPancakeError(parsedBody, bodyText)}`);
  }

  return parsedBody;
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

function parseJsonBody(text: string): PancakeActionResponse | null {
  if (!text) {
    return null;
  }

  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" ? parsed as PancakeActionResponse : null;
  } catch {
    return null;
  }
}

function formatPancakeError(body: { message?: string } | null, bodyText: string): string {
  return body?.message ?? (bodyText || "unknown_error");
}

function toHandoffToolResponse(
  tag: PancakeActionResponse | null,
  unread: PancakeActionResponse | null,
): HandoffToolResponse {
  return {
    success: true,
    message: firstNonEmptyString(unread?.message, tag?.message) ?? "Conversation handed off to human staff.",
    actions: {
      tag,
      unread,
    },
  };
}

function assertTagApplied(body: PancakeActionResponse | null, tagId: string): void {
  if (!Array.isArray(body?.data)) {
    return;
  }

  const tagIds = body.data.map((entry) => String(entry));
  if (!tagIds.includes(tagId)) {
    throw new Error(`Pancake handoff failed: response did not include tag ${tagId}`);
  }
}
