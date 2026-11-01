/**
 * Model-facing question from a persistent subagent to the run that started it.
 * Asking ends the child's turn: the question rides its result row to the parent,
 * and the parent's answer resumes the child conversation as its next turn.
 */

import { jsonSchema, tool, type ToolSet } from "ai";
import { toolError, type AskParent } from "./utils.ts";

interface AskParentInput {
  question: string;
}

export default function askParentTool(askParent: AskParent): ToolSet {
  return {
    ask_parent: tool({
      description:
        "Ask the agent that started you a question. Your turn ends after this step, and the answer arrives as your next message, with your work so far intact. Use it when a decision is theirs to make or you are missing context only they have. Ask one clear question with the context they need; do not use it for progress updates.",
      inputSchema: jsonSchema<AskParentInput>({
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "The question, with the context the parent needs.",
          },
        },
        required: ["question"],
        additionalProperties: false,
      }),
      execute: async function (input): Promise<string> {
        const question = input.question.trim();
        if (!question) {
          return toolError("Error: ask_parent requires a non-empty question");
        }
        if (!askParent(question)) {
          return toolError(
            "Error: you already asked the parent a question this turn",
          );
        }

        return "Question sent to the parent. Stop here: your turn ends now and the answer arrives as your next message.";
      },
    }),
  };
}
