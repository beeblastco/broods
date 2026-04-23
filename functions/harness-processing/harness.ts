/**
 * Agent-side harness core.
 * Keep turn context assembly, model invocation, and tools orchestration here.
 */

import { createGoogleGenerativeAI } from "@ai-sdk/google";
import {
  stepCountIs,
  streamText,
  type ModelMessage,
  type ToolSet,
  type UserContent,
} from "ai";
import { requireEnv } from "../_shared/env.ts";
import { logError, logInfo } from "../_shared/log.ts";
import type { Session } from "./session.ts";
import { createTools } from "./tools/index.ts";

const google = createGoogleGenerativeAI({
  apiKey: requireEnv("GOOGLE_API_KEY"),
});

const GOOGLE_MODEL_ID = requireEnv("GOOGLE_MODEL_ID");
const DEFAULT_SYSTEM_PROMPT = requireEnv("DEFAULT_SYSTEM_PROMPT");
const SLIDING_CONTEXT_WINDOW = Number(requireEnv("SLIDING_CONTEXT_WINDOW"));
const MAX_AGENT_ITERATIONS = Number(requireEnv("MAX_AGENT_ITERATIONS"));

export interface AgentReplyHooks {
  onFinalText(text: string): Promise<void>;
  onErrorText(): Promise<void>;
}

export function runAgentLoop(
  session: Session,
  userContent: UserContent,
  history: ModelMessage[],
  reply?: AgentReplyHooks,
) {
  const windowStart = Math.max(0, history.length - SLIDING_CONTEXT_WINDOW);
  let recentHistory = history.slice(windowStart);

  while (recentHistory.length > 0 && recentHistory[0]?.role !== "user") {
    recentHistory = recentHistory.slice(1);
  }

  const messages: ModelMessage[] = [
    ...recentHistory,
    { role: "user", content: userContent },
  ];

  const tools = {
    ...createTools({
      conversationKey: session.conversationKey,
    }),
  } satisfies ToolSet;

  return streamText({
    model: google(GOOGLE_MODEL_ID),
    system: DEFAULT_SYSTEM_PROMPT,
    messages,
    tools,
    maxOutputTokens: 16000,
    providerOptions: {
      google: {
        thinkingConfig: {
          thinkingLevel: "high",
        },
      },
    },
    stopWhen: stepCountIs(MAX_AGENT_ITERATIONS),
    onError: async ({ error }) => {
      logError("Agent loop failed", {
        conversationKey: session.conversationKey,
        error: error instanceof Error ? error.message : String(error),
      });

      await reply?.onErrorText().catch(() => { });
    },
    onFinish: async ({ response, text }) => {
      const finalText = text.trim();

      try {
        await session.persistModelMessages(response.messages);

        if (!finalText) {
          logError("Model returned empty response", {
            conversationKey: session.conversationKey,
            eventId: session.eventId,
          });
          return;
        }

        await reply?.onFinalText(finalText);
        logInfo("Processing complete", { conversationKey: session.conversationKey });
      } catch (err) {
        logError("Post-generation steps failed", {
          conversationKey: session.conversationKey,
          error: err instanceof Error ? err.message : String(err),
        });

        await reply?.onErrorText().catch(() => { });
      }
    },
  });
}
