/**
 * Maps the runtime's stored conversation events (sanitized AI SDK
 * ModelMessages, served by `conversationsPublic.listMessages`) into the
 * `UIMessage` shape the Test chat renders. User and assistant messages map
 * one-to-one; tool-result messages fold their outputs back into the previous
 * assistant message's tool parts, matching how the live stream renders.
 */

import type {
  DynamicToolUIPart,
  ReasoningUIPart,
  TextUIPart,
  UIMessage,
} from "ai";

/** One transcript row from `conversationsPublic.listMessages`. */
export interface StoredConversationEventRow {
  cursor: string;
  event: unknown;
}

/** The persisted stored-event envelope (harness/session.ts). */
interface StoredEnvelope {
  message?: {
    role?: unknown;
    content?: unknown;
  };
}

/** A ModelMessage content part, loosely — only the fields the mapper reads. */
interface StoredContentPart {
  type?: unknown;
  text?: unknown;
  toolCallId?: unknown;
  toolName?: unknown;
  input?: unknown;
  args?: unknown;
  output?: unknown;
  result?: unknown;
}

/** Tool outputs are wrapped as `{type, value}` by the AI SDK; unwrap them. */
function unwrapToolOutput(raw: unknown): { output: unknown; isError: boolean } {
  const wrapped = raw as { type?: unknown; value?: unknown } | null;
  if (wrapped && typeof wrapped === "object" && "value" in wrapped) {
    const isError =
      wrapped.type === "error-text" || wrapped.type === "error-json";

    return { output: wrapped.value, isError: isError };
  }

  return { output: raw, isError: false };
}

function textPart(text: string): TextUIPart {
  return { type: "text", text: text, state: "done" };
}

function contentParts(content: unknown): StoredContentPart[] {
  return Array.isArray(content) ? (content as StoredContentPart[]) : [];
}

function userParts(content: unknown): TextUIPart[] {
  if (typeof content === "string") {
    return content.trim() ? [textPart(content)] : [];
  }

  return contentParts(content).flatMap((part) => {
    if (part.type === "text" && typeof part.text === "string") {
      return [textPart(part.text)];
    }
    // Image/file attachments have no chat renderer yet (ticket 13).
    if (part.type === "image" || part.type === "file") {
      return [textPart("[attachment]")];
    }

    return [];
  });
}

function assistantParts(content: unknown): UIMessage["parts"] {
  if (typeof content === "string") {
    return content.trim() ? [textPart(content)] : [];
  }

  return contentParts(content).flatMap((part): UIMessage["parts"] => {
    if (part.type === "text" && typeof part.text === "string") {
      return part.text.trim() ? [textPart(part.text)] : [];
    }
    if (part.type === "reasoning" && typeof part.text === "string") {
      const reasoning: ReasoningUIPart = {
        type: "reasoning",
        text: part.text,
        state: "done",
      };

      return part.text.trim() ? [reasoning] : [];
    }
    if (
      part.type === "tool-call" &&
      typeof part.toolCallId === "string" &&
      typeof part.toolName === "string"
    ) {
      const tool: DynamicToolUIPart = {
        type: "dynamic-tool",
        toolName: part.toolName,
        toolCallId: part.toolCallId,
        state: "input-available",
        input: part.input ?? part.args ?? {},
      };

      return [tool];
    }

    return [];
  });
}

/** Fold a tool-result message's outputs into prior dynamic-tool parts. */
function applyToolResults(messages: UIMessage[], content: unknown): void {
  for (const part of contentParts(content)) {
    if (part.type !== "tool-result" || typeof part.toolCallId !== "string") {
      continue;
    }
    const { output, isError } = unwrapToolOutput(part.output ?? part.result);
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const parts = messages[index].parts;
      const match = parts.findIndex(
        (candidate) =>
          candidate.type === "dynamic-tool" &&
          candidate.toolCallId === part.toolCallId,
      );
      if (match === -1) continue;
      const call = parts[match] as DynamicToolUIPart;
      parts[match] = isError
        ? {
            type: "dynamic-tool",
            toolName: call.toolName,
            toolCallId: call.toolCallId,
            state: "output-error",
            input: call.input,
            errorText:
              typeof output === "string" ? output : JSON.stringify(output),
          }
        : {
            type: "dynamic-tool",
            toolName: call.toolName,
            toolCallId: call.toolCallId,
            state: "output-available",
            input: call.input,
            output: output,
          };
      break;
    }
  }
}

/** Build the chat transcript from stored events, oldest first. */
export function uiMessagesFromStoredEvents(
  rows: StoredConversationEventRow[],
): UIMessage[] {
  const messages: UIMessage[] = [];
  for (const row of rows) {
    const message = (row.event as StoredEnvelope | null)?.message;
    if (!message) continue;

    if (message.role === "user") {
      const parts = userParts(message.content);
      if (parts.length > 0) {
        messages.push({ id: row.cursor, role: "user", parts: parts });
      }
      continue;
    }
    if (message.role === "assistant") {
      const parts = assistantParts(message.content);
      if (parts.length > 0) {
        messages.push({ id: row.cursor, role: "assistant", parts: parts });
      }
      continue;
    }
    if (message.role === "tool") {
      applyToolResults(messages, message.content);
    }
    // System messages are prompt plumbing, not transcript.
  }

  return messages;
}

/** Compact relative timestamp for the conversation list ("2h ago"). */
export function relativeTime(timestamp: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;

  return `${Math.round(months / 12)}y ago`;
}
