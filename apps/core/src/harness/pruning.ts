/**
 * Session pruning for model-visible conversation context.
 * Keep transient context cleanup here; persistence stays in session.ts.
 */

import { pruneMessages, type ImagePart, type ModelMessage } from "ai";
import type { AgentConfig } from "../shared/domain/agent-config.ts";
import { STORED_ITEM_PROVIDERS } from "./provider.ts";
import { toolContentItems, type ToolContentPart } from "./tools/utils.ts";

const NO_IMAGES: readonly ImagePart[] = [];

export function pruneSessionMessages(
  messages: ModelMessage[],
  agentConfig: AgentConfig,
): ModelMessage[] {
  const approvalResume = hasPendingToolApprovalResponse(messages);
  const retainsReasoning = retainsReasoningParts(agentConfig);
  const modelMessages =
    approvalResume || retainsReasoning
      ? messages
      : stripReasoningFromMessages(messages);
  // An approval resume keeps the assistant tool call its approvalId points at.
  const keptMessages = approvalResume ? 2 : 1;

  if (agentConfig.session?.pruning?.enabled === false) {
    return modelMessages;
  }

  return pruneMessages({
    messages: retainsReasoning
      ? modelMessages
      : withToolImagesKept(modelMessages, modelMessages.length - keptMessages),
    // Never `before-last-message` here. Half-stripping leaves older assistant
    // messages referencing stored items whose reasoning is gone, which is the
    // same rejection this retention exists to avoid, only deferred a turn.
    reasoning: "none",
    // A pruned tool call orphans its reasoning item on a stored-item provider.
    toolCalls: retainsReasoning
      ? "none"
      : `before-last-${keptMessages}-messages`,
    emptyMessages: "remove",
  });
}

/**
 * Whether reasoning must survive into the next model call. On a stored-item
 * provider it is not an optimization: the assistant message goes back as a
 * reference to the item the provider already holds, and the reference is
 * rejected without the reasoning item that produced it.
 */
export function retainsReasoningParts(agentConfig: AgentConfig): boolean {
  const provider = agentConfig.model?.provider;

  return provider !== undefined && STORED_ITEM_PROVIDERS.has(provider);
}

export function stripReasoningFromMessages(
  messages: ModelMessage[],
): ModelMessage[] {
  return pruneMessages({
    messages: messages,
    reasoning: "all",
    emptyMessages: "remove",
  });
}

export function hasPendingToolApprovalResponse(
  messages: ModelMessage[],
): boolean {
  const lastMessage = messages.at(-1);

  return (
    lastMessage?.role === "tool" &&
    lastMessage.content.length > 0 &&
    lastMessage.content.every((part) => part.type === "tool-approval-response")
  );
}

/**
 * A tool result's content item as a picture a user message can carry. Shared
 * empty result, so the check for any picture allocates nothing per item.
 */
function toolImage(item: ToolContentPart): readonly ImagePart[] {
  switch (item.type) {
    case "image-data":
      return [{ type: "image", image: item.data, mediaType: item.mediaType }];
    case "image-url":
      return [{ type: "image", image: item.url }];
    case "file-data":
      return item.mediaType.startsWith("image")
        ? [{ type: "image", image: item.data, mediaType: item.mediaType }]
        : NO_IMAGES;
    case "file-url":
      return item.mediaType?.startsWith("image")
        ? [{ type: "image", image: item.url, mediaType: item.mediaType }]
        : NO_IMAGES;
    case "file":
      return item.mediaType.startsWith("image") &&
        (item.data.type === "data" || item.data.type === "url")
        ? [
            {
              type: "image",
              image: item.data.type === "data" ? item.data.data : item.data.url,
              mediaType: item.mediaType,
            },
          ]
        : NO_IMAGES;
    default:
      return NO_IMAGES;
  }
}

/**
 * Pruning drops every tool call before `prunedBefore`, and the pictures their
 * results carried would go with them. Each tool message there is followed by a
 * user message holding its pictures, which pruning keeps, so the model sees a
 * screenshot on every later turn, not only the one that took it.
 */
function withToolImagesKept(
  messages: ModelMessage[],
  prunedBefore: number,
): ModelMessage[] {
  const carriesImages = messages.some(
    (message, index): boolean =>
      index < prunedBefore &&
      message.role === "tool" &&
      message.content.some(
        (part): boolean =>
          part.type === "tool-result" &&
          part.output.type === "content" &&
          part.output.value.some((item): boolean => toolImage(item).length > 0),
      ),
  );
  if (!carriesImages) {
    return messages;
  }

  return messages.flatMap((message, index): ModelMessage[] => {
    if (message.role !== "tool" || index >= prunedBefore) {
      return [message];
    }
    const images = toolContentItems(message).flatMap(toolImage);
    if (images.length === 0) {
      return [message];
    }

    return [
      message,
      {
        role: "user",
        content: [
          { type: "text", text: "Images a tool returned earlier:" },
          ...images,
        ],
      },
    ];
  });
}
