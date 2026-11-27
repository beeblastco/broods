import { jsonSchema, tool, type ToolSet } from "ai";
import {
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
  waitSeconds?: number;
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
        "Send a message to another agent of your subagent family and, with waitSeconds, get its reply.",
        `to is ${targets.join(", or ")}.`,
        "A running agent reads it at its next step; an idle one starts a new turn on it.",
        `waitSeconds waits for the reply up to that long (at most ${MAX_AGENT_WAIT_SECONDS}); then you carry on and a late reply arrives as a later message. Leave it out to send without waiting.`,
        ...(context.parent
          ? [
              'Waiting on "parent" (any waitSeconds) ends your turn after this step; its reply, or a note to carry on if it ends its turn without one, arrives as your next message. Use it when a decision is theirs or only they have the context, not for progress updates.',
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
          waitSeconds: {
            type: "number",
            description: `Seconds to wait for the reply, at most ${MAX_AGENT_WAIT_SECONDS}. Leave it out to not wait.`,
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
        const followUp = input.followUp?.trim();
        const message: AgentMessage = {
          text: text,
          exchangeId: followUp || `ex_${crypto.randomUUID().slice(0, 8)}`,
          followUp: Boolean(followUp),
          ...(input.waitSeconds !== undefined &&
          Number.isFinite(input.waitSeconds)
            ? {
                waitSeconds: Math.min(
                  Math.max(Math.round(input.waitSeconds), 1),
                  MAX_AGENT_WAIT_SECONDS,
                ),
              }
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
