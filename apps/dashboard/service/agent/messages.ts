/**
 * Converts persisted Convex messages to AI SDK CoreMessage format.
 */
import type { AssistantContent, ModelMessage, ToolContent } from "@ai-sdk/provider-utils";


/**
 * Converts Convex messages to AI SDK CoreMessage format.
 * Maps field name differences: input→args, output→result.
 * Filters out approval-related content parts.
 */
export function convertToAiSdkMessages(
  rawMessages: Array<{ role: string; content: unknown; providerOptions?: unknown }>,
): ModelMessage[] {
  const result: ModelMessage[] = [];

  for (const msg of rawMessages) {
    const { role, content } = msg;

    // Handle string content
    if (typeof content === "string") {
      if (role === "system") {
        result.push({ role: "system", content: content });
      } else if (role === "assistant") {
        result.push({ role: "assistant", content: content });
      } else {
        result.push({ role: "user", content: content });
      }
      continue;
    }

    // Handle array content
    if (!Array.isArray(content)) {
      continue;
    }

    // Filter out approval-related parts
    const parts = content.filter(
      (p: { type?: string }) =>
        p.type !== "tool-approval-request" &&
        p.type !== "tool-approval-response",
    );

    if (parts.length === 0) {
      continue;
    }

    if (role === "tool") {
      // Tool messages contain tool-result parts
      const toolParts: ToolContent = parts.map((p: Record<string, unknown>) => {
        if (p.type === "tool-result") {
          return {
            type: "tool-result" as const,
            toolCallId: p.toolCallId as string,
            toolName: p.toolName as string,
            output: p.output ?? p.result, // DB may store as "output" or legacy "result"
          } as ToolContent[number];
        }

        // Fallback: treat as text tool result
        return {
          type: "tool-result" as const,
          toolCallId: (p.toolCallId as string) ?? "unknown",
          toolName: (p.toolName as string) ?? "unknown",
          output: p.text ?? JSON.stringify(p),
        } as ToolContent[number];
      });

      result.push({ role: "tool", content: toolParts });
    } else if (role === "assistant") {
      // Assistant messages can contain text, reasoning, and tool-call parts
      const assistantParts = parts.map((p: Record<string, unknown>) => {
        if (p.type === "tool-call") {
          return {
            type: "tool-call" as const,
            toolCallId: p.toolCallId as string,
            toolName: p.toolName as string,
            input: (p.input ?? p.args ?? {}) as Record<string, unknown>, // DB may store as "input" or legacy "args"
          };
        }

        // text, reasoning, etc. pass through directly
        return p;
      });

      result.push({
        role: "assistant",
        content: assistantParts as AssistantContent,
      });
    } else if (role === "system") {
      // System messages with array content: extract text
      const text = parts
        .filter((p: { type?: string }) => p.type === "text")
        .map((p: { text?: string }) => p.text ?? "")
        .join("\n");
      if (text.trim()) {
        result.push({ role: "system", content: text });
      }
    } else {
      // User messages pass through
      result.push({ role: "user", content: parts });
    }
  }

  return result;
}
