/**
 * Model-facing question from a persistent subagent to the run that started it.
 * The coordinator queues the question for the parent and routes its answer back.
 */

import { jsonSchema, tool, type ToolSet } from "ai";
import { toolError } from "./utils.ts";

interface AskParentInput {
  question: string;
}

type AskParentOutput = { answer: string } | { answer: null; note: string };

export default function askParentTool(
  askParent: (question: string) => Promise<string | null>,
): ToolSet {
  return {
    ask_parent: tool({
      description:
        "Ask the agent that started you a question and wait for its answer, up to a few minutes. Use it when a decision is theirs to make or you are missing context only they have. Ask one clear question; do not use it for progress updates.",
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
      execute: async function (
        input,
        { abortSignal },
      ): Promise<AskParentOutput> {
        const question = input.question.trim();
        if (!question) {
          return toolError("Error: ask_parent requires a non-empty question");
        }
        const stopped = new Promise<null>((resolve) => {
          abortSignal?.addEventListener("abort", () => resolve(null), {
            once: true,
          });
        });
        const answer = await Promise.race([askParent(question), stopped]);

        return answer === null
          ? {
              answer: null,
              note: "No answer from the parent. Continue with your best judgment and say what you assumed.",
            }
          : { answer: answer };
      },
    }),
  };
}
