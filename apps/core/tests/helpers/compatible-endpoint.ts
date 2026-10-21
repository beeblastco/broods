/**
 * A fake OpenAI-compatible chat endpoint for the custom-provider tests: it
 * keeps every request body it receives and answers from a list of statuses.
 * The model class, not the factory: harness.test.ts mocks
 * `createOpenAICompatible` for the files after it.
 */

import { OpenAICompatibleChatLanguageModel } from "@ai-sdk/openai-compatible";

// A chat-completions request body as the compatible converter builds it.
export type ChatRequest = {
  messages: { role: string; content: unknown; tool_call_id?: string }[];
  [field: string]: unknown;
};

/**
 * A `modelId` chat model on a fresh endpoint, and the bodies it was sent. Call
 * n is answered by `statuses[n]`: 200 (the default) replies "ok", anything else
 * refuses an image.
 */
export function compatibleEndpoint(
  modelId: string,
  statuses: number[] = [],
): { bodies: ChatRequest[]; chat: OpenAICompatibleChatLanguageModel } {
  const bodies: ChatRequest[] = [];
  const chat = new OpenAICompatibleChatLanguageModel(modelId, {
    provider: "custom.chat",
    url: ({ path }): string => `https://models.example.test/v1${path}`,
    supportsMultiPartToolContent: true,
    fetch: Object.assign(
      async (
        _url: Parameters<typeof fetch>[0],
        init?: RequestInit,
      ): Promise<Response> => {
        if (typeof init?.body === "string") bodies.push(JSON.parse(init.body));
        const status = statuses[bodies.length - 1] ?? 200;

        return status === 200
          ? Response.json({
              choices: [
                {
                  message: { role: "assistant", content: "ok" },
                  finish_reason: "stop",
                },
              ],
            })
          : Response.json(
              { error: { message: "image input is not supported" } },
              { status: status },
            );
      },
      { preconnect: fetch.preconnect },
    ),
  });

  return { bodies: bodies, chat: chat };
}
