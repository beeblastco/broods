// Builds the model class, not the factory: harness.test.ts mocks `createOpenAICompatible`
// for the files after it.

import { OpenAICompatibleChatLanguageModel } from "@ai-sdk/openai-compatible";

export type ChatRequest = {
  messages: {
    role: string;
    content: unknown;
    tool_call_id?: string;
    cache_control?: unknown;
  }[];
  [field: string]: unknown;
};

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
