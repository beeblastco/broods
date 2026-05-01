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
import type { AccountConfig } from "../_shared/accounts.ts";
import { requireEnv } from "../_shared/env.ts";
import { logError, logInfo } from "../_shared/log.ts";
import type { Session, TurnContextSnapshot } from "./session.ts";
import { createTools } from "./tools/index.ts";

const GOOGLE_MODEL_ID = requireEnv("GOOGLE_MODEL_ID");
const MAX_AGENT_ITERATIONS = Number(requireEnv("MAX_AGENT_ITERATIONS"));

const google = createGoogleGenerativeAI({ apiKey: requireEnv("GOOGLE_API_KEY") });

export interface AgentReplyHooks {
  onFinalText(text: string): Promise<void>;
  onErrorText(error: string): Promise<void>;
}

export async function runAgentLoop(
  session: Session,
  turnContext: TurnContextSnapshot,
  accountConfig: AccountConfig,
  reply?: AgentReplyHooks,
) {
  let didFail = false;
  let failureText: string | null = null;
  let promptContext = turnContext.promptContext;

  const tools = {
    ...createTools({
      conversationKey: session.conversationKey,
      filesystemNamespace: session.filesystemNamespace(),
    }),
  } satisfies ToolSet;

  const stream = streamText({
    model: google(accountConfig.modelId ?? GOOGLE_MODEL_ID),
    system: turnContext.system,
    messages: turnContext.messages,
    tools: tools,
    maxOutputTokens: 16000,
    providerOptions: {
      google: {
        thinkingConfig: {
          thinkingLevel: "high",
        },
      }
    },
    stopWhen: stepCountIs(accountConfig.maxAgentIterations ?? MAX_AGENT_ITERATIONS),
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
      const errorText = error instanceof Error ? error.message : String(error);
      didFail = true;
      failureText = errorText;
      logError("Agent loop failed", {
        conversationKey: session.conversationKey,
        error: errorText,
      });

      await reply?.onErrorText(errorText).catch(() => { });
    },
    onFinish: async ({ response, text }) => {
      const finalText = text.trim();

      try {
        await session.persistModelMessages(response.messages);

        if (!finalText) {
          const errorText = "Model returned empty response";
          didFail = true;
          failureText = errorText;
          logError(errorText, {
            conversationKey: session.conversationKey,
            eventId: session.eventId,
          });
          await reply?.onErrorText(errorText).catch(() => { });
          return;
        }

        await reply?.onFinalText(finalText);
        logInfo("Processing complete", { conversationKey: session.conversationKey });
      } catch (err) {
        const errorText = err instanceof Error ? err.message : String(err);
        didFail = true;
        failureText = errorText;
        logError("Post-generation steps failed", {
          conversationKey: session.conversationKey,
          error: errorText,
        });

        await reply?.onErrorText(errorText).catch(() => { });
      }
    },
  });

  return Object.assign(stream, {
    didFail: () => didFail,
    failureText: () => failureText,
  });
}
