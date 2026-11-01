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
    // Not `before-last-message`: older stored-item references would lose their reasoning.
    reasoning: "none",
    // A pruned tool call orphans its reasoning item on a stored-item provider.
    toolCalls: retainsReasoning
      ? "none"
      : `before-last-${keptMessages}-messages`,
    emptyMessages: "remove",
  });
}

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

// A URL is left to be pruned, so a link that expires never fails every later turn.
function toolImage(item: ToolContentPart): readonly ImagePart[] {
  switch (item.type) {
    case "image-data":
      return [{ type: "image", image: item.data, mediaType: item.mediaType }];
    case "file-data":
      return item.mediaType.startsWith("image")
        ? [{ type: "image", image: item.data, mediaType: item.mediaType }]
        : NO_IMAGES;
    case "file":
      return item.mediaType.startsWith("image") && item.data.type === "data"
        ? [{ type: "image", image: item.data.data, mediaType: item.mediaType }]
        : NO_IMAGES;
    default:
      return NO_IMAGES;
  }
}

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
