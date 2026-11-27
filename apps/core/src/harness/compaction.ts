import { generateText, type ModelMessage, type SystemModelMessage } from "ai";
import { DEFAULT_COMPACTION_PROMPT } from "../shared/.generated/compaction-prompt.ts";
import type { AgentConfig } from "../shared/domain/agent-config.ts";
import { isContextLengthError, toErrorMessage } from "../shared/errors.ts";
import { logInfo } from "../shared/log.ts";
import {
  modelSettingsFromModelConfig,
  providerOptionsFromModelConfig,
  resolveConfiguredModel,
} from "./provider.ts";
import { stripReasoningFromMessages } from "./pruning.ts";
import {
  addUsageTokenTotals,
  extractCacheWriteTokens,
  modelTokenAttributes,
  usageTokenTotals,
  type UsageTokenTotals,
} from "./usage-metering.ts";

const DEFAULT_AUTO_COMPACTION_MAX_CONTEXT_LENGTH = 500_000;
const MIN_SPLIT_MESSAGE_LENGTH = 1_000;
export const COMPACTION_MARKER = "<session-compaction-summary>";
const COMPACTION_MARKER_END = "</session-compaction-summary>";
const COMPACTION_MESSAGE_SEPARATOR = "\n\n";

export interface CompactionUsage {
  usage: UsageTokenTotals;
  modelCalls: number;
  modelProvider: string;
  modelId: string;
}

export interface ConversationSummary extends CompactionUsage {
  message: SystemModelMessage;
}

export interface CompactionResult extends CompactionUsage {
  messageCount: number;
}

/** `spent` is what the finished summary calls cost, so a failed split is still metered. */
export class CompactionError extends Error {
  readonly spent: CompactionUsage;

  constructor(cause: unknown, spent: CompactionUsage) {
    super(toErrorMessage(cause), { cause: cause });
    this.spent = spent;
  }
}

export interface SummarizeConversationInput {
  accountId?: string;
  conversationKey: string;
  priorSummaries: SystemModelMessage[];
  messages: ModelMessage[];
  agentConfig: AgentConfig;
  instructions?: string;
}

export function shouldAutoCompact(
  agentConfig: AgentConfig,
  lastInputTokens: number | undefined,
  contextExceeded = false,
): boolean {
  const config = agentConfig.session?.autoCompaction;
  if (config?.enabled === false) return false;
  if (contextExceeded) return true;
  if (lastInputTokens === undefined) return false;
  const configuredMax =
    config?.maxContextLength ?? DEFAULT_AUTO_COMPACTION_MAX_CONTEXT_LENGTH;

  return lastInputTokens >= configuredMax;
}

export function compactionSpanAttributes(
  result: CompactionResult,
): Record<string, number> {
  return {
    "compaction.message_count": result.messageCount,
    "compaction.model_calls": result.modelCalls,
    ...modelTokenAttributes(result.usage),
  };
}

export function isCompactionSummaryMessage(
  message: SystemModelMessage,
): boolean {
  return (
    typeof message.content === "string" &&
    message.content.startsWith(COMPACTION_MARKER)
  );
}

export async function summarizeConversation(
  input: SummarizeConversationInput,
): Promise<ConversationSummary | null> {
  const messages = stripReasoningFromMessages(input.messages);
  const compactableContext = [...input.priorSummaries, ...messages];
  if (compactableContext.length === 0) {
    return null;
  }

  const configuredModel = resolveConfiguredModel(
    input.agentConfig,
    input.accountId,
  );
  const providerOptions = providerOptionsFromModelConfig(input.agentConfig);
  const startedAt = Date.now();
  const suffix = formatInstructions(input.instructions);
  let usage = usageTokenTotals(undefined);
  let modelCalls = 0;
  const requestSummary = async (blocks: string[]): Promise<string> => {
    const result = await generateText({
      ...modelSettingsFromModelConfig(input.agentConfig),
      model: configuredModel.model,
      instructions: DEFAULT_COMPACTION_PROMPT,
      runtimeContext: {
        traceName: "harness.compaction",
        properties: process.env.DEPLOYMENT_ENVIRONMENT
          ? { environment: process.env.DEPLOYMENT_ENVIRONMENT }
          : {},
      },
      telemetry: {
        functionId: "harness.compaction",
        includeRuntimeContext: {
          traceName: true,
          properties: true,
        },
        recordInputs: false,
        recordOutputs: false,
      },
      // Per-call data rides the user message so the static system prompt stays cacheable.
      messages: [
        {
          role: "user",
          content: `${blocks.join(COMPACTION_MESSAGE_SEPARATOR)}${suffix}`,
        },
      ],
      ...(providerOptions ? { providerOptions: providerOptions as never } : {}),
    });
    const callUsage = usageTokenTotals(result.usage);
    usage = addUsageTokenTotals(usage, {
      ...callUsage,
      cacheWriteTokens:
        callUsage.cacheWriteTokens ||
        extractCacheWriteTokens(
          configuredModel.providerName,
          result.providerMetadata,
        ),
    });
    modelCalls += 1;

    return result.text;
  };
  const spent = (): CompactionUsage => ({
    usage: usage,
    modelCalls: modelCalls,
    modelProvider: configuredModel.providerName,
    modelId: configuredModel.model.modelId,
  });
  let text: string;
  try {
    text = await summarizeBlocks(
      formatMessagesForCompaction(compactableContext),
      requestSummary,
    );
  } catch (error) {
    throw new CompactionError(error, spent());
  }

  const durationMs = Date.now() - startedAt;
  logInfo(
    `Session context compacted: ${input.messages.length} message(s), ${modelCalls} model call(s), ${usage.inputTokens} in / ${usage.outputTokens} out / ${usage.totalTokens} total token(s), ${durationMs}ms`,
    {
      eventType: "session.compacted",
      conversationKey: input.conversationKey,
      ...spent(),
      messageCount: input.messages.length,
      compactedMessageCount: compactableContext.length,
      durationMs: durationMs,
    },
  );

  return { ...spent(), message: createCompactionSummaryMessage(text) };
}

function createCompactionSummaryMessage(summary: string): SystemModelMessage {
  return {
    role: "system",
    content: `${COMPACTION_MARKER}\nThe following is a compacted summary of earlier conversation history. Treat it as context for this conversation and prefer newer explicit messages when they conflict.\n\n${summary.trim()}\n${COMPACTION_MARKER_END}`,
  };
}

function formatInstructions(instructions?: string): string {
  const trimmed = instructions?.trim();

  return trimmed
    ? `${COMPACTION_MESSAGE_SEPARATOR}The user requested this compaction with instructions. Follow them when choosing what to preserve and emphasize:\n${trimmed}`
    : "";
}

function formatMessagesForCompaction(messages: ModelMessage[]): string[] {
  return messages.map((message, index): string => {
    return `Message ${index + 1} (${message.role}):\n${stringifyMessageContent(message.content)}`;
  });
}

function stringifyMessageContent(content: ModelMessage["content"]): string {
  return typeof content === "string" ? content : JSON.stringify(content);
}

// Splits only on a length refusal, never dropping a whole message: a lone message keeps its
// start, and a refused merge fails the compaction so the stored history stays as it was.
async function summarizeBlocks(
  blocks: string[],
  requestSummary: (blocks: string[]) => Promise<string>,
): Promise<string> {
  try {
    return await requestSummary(blocks);
  } catch (error) {
    if (!isContextLengthError(toErrorMessage(error))) throw error;
    const [block] = blocks;
    if (blocks.length === 1 && block !== undefined) {
      if (block.length < MIN_SPLIT_MESSAGE_LENGTH) throw error;
      return summarizeBlocks(
        [block.slice(0, Math.floor(block.length / 2))],
        requestSummary,
      );
    }
    const middle = Math.ceil(blocks.length / 2);

    return requestSummary([
      `Older part:\n${await summarizeBlocks(blocks.slice(0, middle), requestSummary)}`,
      `Newer part:\n${await summarizeBlocks(blocks.slice(middle), requestSummary)}`,
    ]);
  }
}
