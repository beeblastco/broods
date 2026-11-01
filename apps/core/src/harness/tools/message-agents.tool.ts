/**
 * Model-facing messages between agents of one subagent family, both ways: a
 * parent to its persistent children by address, a persistent child to its
 * parent. Delivery and waiting live in the subagent coordinator; this file only
 * validates input and shapes the result.
 */

import { jsonSchema, tool, type ToolSet } from "ai";
import {
  DEFAULT_AGENT_WAIT_SECONDS,
  MAX_AGENT_WAIT_SECONDS,
  toolError,
  type AgentMessage,
  type AgentMessageResult,
  type MessageChild,
  type ParentLink,
} from "./utils.ts";

const PARENT = "parent";

interface MessageAgentsInput {
  to: string;
  text: string;
  wait?: boolean;
  timeoutSeconds?: number;
  followUp?: string;
}

export default function messageAgentsTool(context: {
  messageChild?: MessageChild;
  parent?: ParentLink;
}): ToolSet {
  const targets = [
    ...(context.parent ? [`"${PARENT}" for the agent that started you`] : []),
    ...(context.messageChild
      ? ["a subagent's address, as run_subagent returned it"]
      : []),
  ];

  return {
    "message-agents": tool({
      description: [
        "Send a message to another agent of your subagent family and, with wait, get its reply.",
        `to is ${targets.join(", or ")}.`,
        "A running agent reads it at its next step; an idle one starts a new turn on it.",
        `wait: true waits for the reply up to timeoutSeconds (default ${DEFAULT_AGENT_WAIT_SECONDS}, at most ${MAX_AGENT_WAIT_SECONDS}). When it times out you carry on, and a late reply still arrives as a later message.`,
        ...(context.parent
          ? [
              'Waiting on "parent" ends your turn after this step; the reply arrives as your next message with your work intact. Use it when a decision is theirs or you lack context only they have, not for progress updates.',
            ]
          : []),
        "To nudge or ask again in the same exchange, pass the exchangeId you got back as followUp.",
      ].join(" "),
      inputSchema: jsonSchema<MessageAgentsInput>({
        type: "object",
        properties: {
          to: { type: "string", description: "Who gets the message." },
          text: {
            type: "string",
            description: "The message, with the context the reader needs.",
          },
          wait: {
            type: "boolean",
            description: "Wait for the reply. Default false.",
          },
          timeoutSeconds: {
            type: "number",
            description: "How long a wait lasts, in seconds.",
          },
          followUp: {
            type: "string",
            description:
              "An exchangeId from an earlier message, to continue it.",
          },
        },
        required: ["to", "text"],
        additionalProperties: false,
      }),
      execute: async function (input): Promise<AgentMessageResult> {
        const text = input.text.trim();
        if (!text) {
          return toolError("Error: message-agents requires a non-empty text");
        }
        const message: AgentMessage = {
          text: text,
          exchangeId:
            input.followUp?.trim() || `ex_${crypto.randomUUID().slice(0, 8)}`,
          followUp: Boolean(input.followUp?.trim()),
          ...(input.wait === true
            ? { waitSeconds: waitSeconds(input.timeoutSeconds) }
            : {}),
        };
        const to = input.to.trim();
        if (to === PARENT) {
          if (!context.parent) {
            return toolError("Error: you have no parent agent to message");
          }
          if (message.waitSeconds === undefined) {
            return context.parent.note(message);
          }
          if (!context.parent.ask(message)) {
            return toolError(
              "Error: you already wait on your parent this turn",
            );
          }

          return {
            status: "delivered",
            exchangeId: message.exchangeId,
            note: "Sent. Stop here: your turn ends now and the reply arrives as your next message.",
          };
        }
        if (!context.messageChild) {
          return toolError(
            `Error: ${to} is not an agent you can message. Use "${PARENT}"`,
          );
        }

        return context.messageChild(to, message);
      },
    }),
  };
}

function waitSeconds(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) {
    return DEFAULT_AGENT_WAIT_SECONDS;
  }

  return Math.min(Math.max(Math.round(requested), 1), MAX_AGENT_WAIT_SECONDS);
}
