/**
 * Agent-side harness core.
 * Keep turn context assembly, model invocation, and tools orchestration here. 
 */

import {
  stepCountIs,
  streamText,
  type ToolSet,
} from "ai";
import type { AccountConfig } from "../_shared/accounts.ts";
import { logError, logInfo, logWarn } from "../_shared/log.ts";
import { modelSettingsFromModelConfig, resolveConfiguredModel } from "./model.ts";
import type { Session, TurnContextSnapshot } from "./session.ts";
import { createTools } from "./tools/index.ts";
import loadSkillTool from "./tools/load-skill.tool.ts";

// Default max agent iterations to prevent looping or too long execution.
const MAX_AGENT_ITERATIONS = 30;

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
  const configuredModel = resolveConfiguredModel(accountConfig);

  const tools = {
    ...createTools({
      conversationKey: session.conversationKey,
      filesystemNamespace: session.filesystemNamespace(),
      modelProviderName: configuredModel.providerName,
      modelProvider: configuredModel.provider,
    }, accountConfig),
    // This part is to check if the skill is enabled and allowed to be used.
    ...(accountConfig.skills?.enabled === true && 
      (accountConfig.skills.allowed?.length ?? 0) > 0 
      ? loadSkillTool(session) : {}), // Else return nothing
  } satisfies ToolSet;
  const enabledTools = Object.keys(tools).length > 0 ? tools : undefined;
  const modelSettings = modelSettingsFromModelConfig(accountConfig);

  const stream = streamText({
    maxOutputTokens: 16000,
    ...modelSettings,
    model: configuredModel.model,
    system: turnContext.system,
    messages: turnContext.messages,
    ...(enabledTools ? { tools: enabledTools } : {}),
    ...(accountConfig.model?.options ? { providerOptions: accountConfig.model.options as never } : {}),
    stopWhen: stepCountIs(accountConfig.agent?.maxTurn ?? MAX_AGENT_ITERATIONS),
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
        eventId: session.eventId,
        error: errorText,
      });

      await reply?.onErrorText(errorText).catch(() => { });
    },
    onFinish: async ({ response, text, finishReason, steps, toolCalls }) => {
      const finalText = text.trim();
      const stepCount = steps.length;
      const toolCallCount = toolCalls.length;

      try {
        await session.persistModelMessages(response.messages);

        if (!finalText) {
          if (didFail) {
            logWarn("Model finished empty after a prior agent loop failure", {
              conversationKey: session.conversationKey,
              eventId: session.eventId,
              failureText,
              finishReason,
              stepCount,
              toolCallCount,
            });
            return;
          }

          const errorText = [
            "Model returned empty response",
            `(finishReason: ${finishReason}, steps: ${stepCount}, toolCalls: ${toolCallCount})`,
          ].join(" ");
          didFail = true;
          failureText = errorText;
          logError(errorText, {
            conversationKey: session.conversationKey,
            eventId: session.eventId,
            finishReason,
            stepCount,
            toolCallCount,
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
