/**
 * Human handoff tool.
 * Keep provider-specific handoff actions here; webhook parsing stays in _shared.
 * 
 * We don't want to reference too much from the zalo channel as this tool will be migrate away from the current code base, so its much better if we define all in here.
 */

import { jsonSchema, tool, type ToolSet } from "ai";
import type { AgentChannelsConfig } from "../../_shared/storage/index.ts";
import type { ToolContext } from "./index.ts";

const ZALO_API_BASE = "https://bot-api.zaloplatforms.com";

type HandoffScenario = "order" | "pending";

interface HandoffsToolContext extends ToolContext {
  channels?: AgentChannelsConfig;
}

interface HandoffToolInput {
  scenario: HandoffScenario;
  reason: string;
  phoneNumber?: string;
}

interface HandoffsRuntimeConfig {
  pancake: {
    scenarioTagIds: Record<HandoffScenario, string>;
  };
  zalo: {
    botToken: string;
    notifyUserIds: string[];
  };
}

interface PancakeActionResponse {
  success?: boolean;
  message?: string;
  data?: unknown;
}

interface ZaloPingResponse {
  userId: string;
  ok: true;
}

interface HandoffToolResponse {
  success: boolean;
  message: string;
  actions: {
    scenarioTag: PancakeActionResponse | null;
    unread: PancakeActionResponse | null;
    zalo: ZaloPingResponse[];
  };
}

// Intentionally duplicate interface.
interface ZaloApiResponse<T = unknown> {
  ok?: boolean;
  result?: T;
  error_code?: number;
  description?: string;
}

export default function handoffsTool(context: HandoffsToolContext): ToolSet {
  return {
    handoffs: tool({
      description:
        "Hand off the current customer conversation to sale staff when the customer wants to order or when the conversation requires staff follow-up. For order handoffs, collect the phone number before calling this tool.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          scenario: {
            type: "string",
            enum: ["order", "pending"],
            description:
              "Use order when the customer wants to place an order. Use pending when sale staff need to follow up.",
          },
          reason: {
            type: "string",
            description: "Short reason for the handoff to include in the sale-team ping.",
          },
          phoneNumber: {
            type: "string",
            description: "Customer phone number. Required when scenario is order.",
          },
        },
        additionalProperties: false,
        required: ["scenario", "reason"],
      }),
      execute: async (input) => {
        const handoff = normalizeHandoffInput(input);
        if (handoff.scenario === "order" && !handoff.phoneNumber) {
          throw new Error("phoneNumber is required for order handoffs");
        }

        const conversation = parsePancakeConversationKey(context.conversationKey);
        const pageAccessToken = resolvePageAccessToken(context);
        const config = resolveHandoffsConfig(context);
        const scenarioTagId = config.pancake.scenarioTagIds[handoff.scenario];

        const scenarioTag = await addHandoffTag(conversation, pageAccessToken, scenarioTagId);
        const unread = await markConversationUnread(conversation, pageAccessToken);
        const zalo = await pingZaloSaleStaff(config, conversation, handoff);

        return toHandoffToolResponse(scenarioTag, unread, zalo);
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
  const parsedBody = parseJsonBody(bodyText) as PancakeActionResponse;

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

function normalizeHandoffInput(input: unknown): HandoffToolInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("handoffs input must be an object");
  }

  const record = input as Record<string, unknown>;
  const scenario = record.scenario;
  if (scenario !== "order" && scenario !== "pending") {
    throw new Error("scenario must be one of: order, pending");
  }

  return {
    scenario,
    reason: firstNonEmptyString(record.reason) ?? missingConfig("reason"),
    ...(firstNonEmptyString(record.phoneNumber) ? { phoneNumber: firstNonEmptyString(record.phoneNumber) } : {}),
  };
}

function resolveHandoffsConfig(context: HandoffsToolContext): HandoffsRuntimeConfig {
  const toolConfig = context.config as Record<string, unknown>;
  const pancake = requirePlainObject(toolConfig.pancake, "config.tools.handoffs.pancake");
  const scenarioTagIds = requirePlainObject(
    pancake.scenarioTagIds,
    "config.tools.handoffs.pancake.scenarioTagIds",
  );
  const zalo = requirePlainObject(toolConfig.zalo, "config.tools.handoffs.zalo");

  return {
    pancake: {
      scenarioTagIds: {
        order: requireNonEmptyString(
          scenarioTagIds.order,
          "config.tools.handoffs.pancake.scenarioTagIds.order",
        ),
        pending: requireNonEmptyString(
          scenarioTagIds.pending,
          "config.tools.handoffs.pancake.scenarioTagIds.pending",
        ),
      },
    },
    zalo: {
      botToken: requireNonEmptyString(zalo.botToken, "config.tools.handoffs.zalo.botToken"),
      notifyUserIds: requireNonEmptyStringArray(
        zalo.notifyUserIds,
        "config.tools.handoffs.zalo.notifyUserIds",
      ),
    },
  };
}

async function pingZaloSaleStaff(
  config: HandoffsRuntimeConfig,
  conversation: { pageId: string; conversationId: string },
  handoff: HandoffToolInput,
): Promise<ZaloPingResponse[]> {
  const results: ZaloPingResponse[] = [];
  for (const userId of config.zalo.notifyUserIds) {
    await callZaloApi(config.zalo.botToken, "sendMessage", {
      chat_id: userId,
      text: formatZaloHandoffMessage(conversation, handoff),
    });
    results.push({ userId, ok: true });
  }
  return results;
}

// Define duplicate because this tool will be migrate away later, we want to centralize all here so that it can be moved easier.
async function callZaloApi(
  botToken: string,
  method: "sendMessage" | "sendChatAction",
  body: Record<string, unknown>,
): Promise<ZaloApiResponse> {
  const response = await fetch(`${ZALO_API_BASE}/bot${botToken}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const bodyText = await response.text();
  const parsed = parseJsonBody(bodyText) as ZaloApiResponse;

  if (!response.ok || parsed?.ok === false) {
    throw new Error(`Zalo ${method} failed (${response.status}): ${formatZaloError(parsed, bodyText)}`);
  }

  return parsed ?? { ok: true };
}

function formatZaloError(body: ZaloApiResponse | null, bodyText: string): string {
  return body?.description ?? body?.error_code?.toString() ?? (bodyText || "unknown_error");
}

function formatZaloHandoffMessage(
  conversation: { pageId: string; conversationId: string },
  handoff: HandoffToolInput,
): string {
  return [
    "[Pancake handoff]",
    `Scenario: ${handoff.scenario}`,
    `Reason: ${handoff.reason}`,
    ...(handoff.phoneNumber ? [`Phone: ${handoff.phoneNumber}`] : []),
    `Page ID: ${conversation.pageId}`,
    `Conversation ID: ${conversation.conversationId}`,
  ].join("\n");
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

function requirePlainObject(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} is required`);
  }
  return value as Record<string, unknown>;
}

function requireNonEmptyString(value: unknown, name: string): string {
  return firstNonEmptyString(value) ?? missingConfig(name);
}

function requireNonEmptyStringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${name} is required`);
  }

  const strings = value.map((entry) => requireNonEmptyString(entry, name));
  if (strings.length === 0) {
    throw new Error(`${name} must contain at least one user id`);
  }
  return strings;
}

function parseJsonBody(text: string): PancakeActionResponse | ZaloApiResponse | null {
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
  scenarioTag: PancakeActionResponse | null,
  unread: PancakeActionResponse | null,
  zalo: ZaloPingResponse[],
): HandoffToolResponse {
  return {
    success: true,
    message: firstNonEmptyString(unread?.message, scenarioTag?.message) ?? "Conversation handed off to human staff.",
    actions: {
      scenarioTag,
      unread,
      zalo,
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
