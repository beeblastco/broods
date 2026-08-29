/**
 * Model-facing steering and follow-up updates for persistent subagent runs.
 * Keep shared parent authorization and types in utils.ts.
 */

import { jsonSchema, tool, type ModelMessage, type ToolSet } from "ai";
import type { AgentConfig } from "../../shared/domain/agent-config.ts";
import { logError } from "../../shared/log.ts";
import {
  publicConversationKeyFromScoped,
  scopedDirectEventId,
} from "../../shared/runtime-keys.ts";
import { getStorage } from "../../shared/storage.ts";
import {
  acceptIngress,
  type AppliedIngress,
  type IngressMode,
} from "../ingress.ts";
import type {
  DispatchAppliedIngress,
  IngressDispatchScope,
} from "../integrations.ts";
import type { Session } from "../session.ts";
import {
  getOwnedSubagent,
  SUBAGENT_TOOL_PROPERTIES,
  subagentNotFound,
  toolError,
  VIRTUAL_AGENT_PREFIX,
  withoutNestedSubagents,
  type SubagentToolContext,
  type SubagentToolInput,
} from "./utils.ts";

interface UpdateSubagentInput extends SubagentToolInput {
  mode: "steer" | "continue";
  message: string;
}

interface UpdateSubagentContext extends SubagentToolContext {
  agentConfig: AgentConfig;
  dispatchAppliedIngress?: DispatchAppliedIngress;
  session: Session;
}

export default function updateSubagentTool(
  context: UpdateSubagentContext,
): ToolSet {
  return {
    update_subagent: tool({
      description:
        'Update a running persistent subagent previously started by this run. Use mode "steer" to change its direction at the next model boundary, or "continue" to queue a follow-up turn after its current work. Completed results are injected automatically, so a late update returns not_running without restarting the child.',
      inputSchema: jsonSchema<UpdateSubagentInput>({
        type: "object",
        properties: {
          ...SUBAGENT_TOOL_PROPERTIES,
          mode: {
            type: "string",
            enum: ["steer", "continue"],
          },
          message: {
            type: "string",
            description: "The non-empty steering instruction or follow-up.",
          },
        },
        required: ["taskId", "agentId", "mode", "message"],
        additionalProperties: false,
      }),
      execute: async function (input) {
        const record = await getOwnedSubagent(context, input);
        if (!record) {
          return toolError(subagentNotFound(input.taskId));
        }

        const message = input.message.trim();
        if (!message) {
          return toolError("Error: update requires a non-empty message");
        }

        const requestedMode: IngressMode =
          input.mode === "steer" ? "steer" : "followup";
        const controlEventId = scopedDirectEventId(
          context.accountId,
          input.agentId,
          crypto.randomUUID(),
        );
        const events: ModelMessage[] = [{ role: "user", content: message }];
        const admission = await acceptIngress({
          activeOwnerOnly: true,
          accountId: context.accountId,
          agentId: input.agentId,
          eventId: controlEventId,
          expectedOwnerTaskId: input.taskId,
          ownerTaskId: input.taskId,
          conversationKey: record.conversationKey,
          events: events,
          requestedMode: requestedMode,
          idempotencyKey: controlEventId,
          delivery: {
            kind: "async",
            publicEventId: controlEventId,
            publicConversationKey: record.conversationKey,
            statusUrl: "",
          },
        });
        if (admission.recovered) {
          await dispatchRecoveredSubagentWork(
            context,
            input,
            record.conversationKey,
            admission.recovered,
          );
        }
        if (admission.outcome === "not_running") {
          return { status: "not_running" };
        }
        if (admission.outcome !== "queued") {
          return toolError(
            `Error: subagent could not accept ${input.mode}: ${admission.outcome}`,
          );
        }

        return { status: "queued", mode: input.mode };
      },
    }),
  };
}

/**
 * Best-effort dispatch of the queued work that admission recovered from an
 * expired child owner. Never throws: the control's own answer must win, and a
 * stranded envelope re-recovers on the next admission after its lease lapses.
 */
async function dispatchRecoveredSubagentWork(
  context: UpdateSubagentContext,
  input: UpdateSubagentInput,
  conversationKey: string,
  recovered: AppliedIngress,
): Promise<void> {
  try {
    if (!context.dispatchAppliedIngress) {
      throw new Error("No applied-ingress dispatcher is wired for this run");
    }
    const agentConfig = await resolveSubagentAgentConfig(context, input);
    if (!agentConfig) {
      throw new Error(`No agent config found for ${input.agentId}`);
    }
    await context.dispatchAppliedIngress(
      subagentDispatchScope(context, input, conversationKey, agentConfig),
      recovered,
    );
  } catch (error) {
    logError("Recovered subagent ingress dispatch failed", {
      conversationKey: conversationKey,
      eventId: recovered.eventId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function resolveSubagentAgentConfig(
  context: UpdateSubagentContext,
  input: UpdateSubagentInput,
): Promise<AgentConfig | null> {
  if (input.agentId === `${VIRTUAL_AGENT_PREFIX}${input.taskId}`) {
    return withoutNestedSubagents(context.agentConfig);
  }

  const agent = await getStorage().agents.getById(
    context.accountId,
    input.agentId,
  );

  return agent ? withoutNestedSubagents(agent.config) : null;
}

function subagentDispatchScope(
  context: UpdateSubagentContext,
  input: UpdateSubagentInput,
  conversationKey: string,
  agentConfig: AgentConfig,
): IngressDispatchScope {
  return {
    accountId: context.accountId,
    agentId: input.agentId,
    agentConfig: agentConfig,
    conversationKey: conversationKey,
    publicConversationKey: publicConversationKeyFromScoped(
      conversationKey,
      context.accountId,
      input.agentId,
    ),
    endpointId: context.session.endpointId,
    projectSlug: context.session.projectSlug,
    stageSlug: context.session.stageSlug,
  };
}
