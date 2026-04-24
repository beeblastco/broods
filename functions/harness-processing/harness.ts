/**
 * Agent-side harness core.
 * Keep turn context assembly, model invocation, and tools orchestration here.
 */

import { createGoogleGenerativeAI } from "@ai-sdk/google";
import {
  stepCountIs,
  streamText,
  type ToolSet,
} from "ai";
import { requireEnv } from "../_shared/env.ts";
import { logError, logInfo } from "../_shared/log.ts";
import type { Session, TurnContextSnapshot } from "./session.ts";
import { createTools } from "./tools/index.ts";

const GOOGLE_MODEL_ID = requireEnv("GOOGLE_MODEL_ID");
const MAX_AGENT_ITERATIONS = Number(requireEnv("MAX_AGENT_ITERATIONS"));

const google = createGoogleGenerativeAI({ apiKey: requireEnv("GOOGLE_API_KEY") });

export interface AgentReplyHooks {
  onFinalText(text: string): Promise<void>;
  onErrorText(): Promise<void>;
}

export async function runAgentLoop(
  session: Session,
  turnContext: TurnContextSnapshot,
  reply?: AgentReplyHooks,
) {
  let didFail = false;
  let promptContext = turnContext.promptContext;

  const tools = {
    ...createTools({
      conversationKey: session.conversationKey,
    }),
  } satisfies ToolSet;

  const stream = streamText({
    model: google(GOOGLE_MODEL_ID),
    system: turnContext.system,
    messages: turnContext.messages,
    tools: tools,
    maxOutputTokens: 16000,
    providerOptions: {
      google: {
        thinkingConfig: {
          thinkingLevel: "high",
        },
      },
    },
    stopWhen: stepCountIs(MAX_AGENT_ITERATIONS),
    prepareStep: async () => {
      const refreshed = await session.loadRefreshedSystemPromptParts({
        promptContext: promptContext,
        ephemeralSystem: turnContext.ephemeralSystem,
      });
      promptContext = refreshed.promptContext;

      return {
        system: refreshed.system,
      };
    },
    onError: async ({ error }) => {
      didFail = true;
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
          didFail = true;
          logError("Model returned empty response", {
            conversationKey: session.conversationKey,
            eventId: session.eventId,
          });
          return;
        }

        await reply?.onFinalText(finalText);
        logInfo("Processing complete", { conversationKey: session.conversationKey });
      } catch (err) {
        didFail = true;
        logError("Post-generation steps failed", {
          conversationKey: session.conversationKey,
          error: err instanceof Error ? err.message : String(err),
        });

        await reply?.onErrorText().catch(() => { });
      }
    },
  });

  return Object.assign(stream, {
    didFail: () => didFail,
  });
}
