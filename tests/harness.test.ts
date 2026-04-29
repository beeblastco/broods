/**
 * Agent harness tests.
 * Cover model-loop edge cases without calling provider APIs.
 */

import { afterEach, describe, expect, it, mock } from "bun:test";

const ORIGINAL_ENV = { ...process.env };

const streamTextMock = mock((options: {
  onFinish(args: { response: { messages: unknown[] }; text: string }): Promise<void>;
}) => {
  let consumed = false;
  const fullStream = new ReadableStream({
    async start(controller) {
      await options.onFinish({
        response: { messages: [] },
        text: "   ",
      });
      controller.enqueue({ type: "finish", finishReason: "stop" });
      controller.close();
    },
  });

  return {
    fullStream,
    async consumeStream() {
      if (consumed) {
        return;
      }

      consumed = true;
      const reader = fullStream.getReader();
      while (!(await reader.read()).done) { }
    },
  };
});

mock.module("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: () => () => ({ provider: "google" }),
}));

mock.module("ai", () => ({
  stepCountIs: () => () => false,
  streamText: streamTextMock,
  tool: (definition: unknown) => definition,
  jsonSchema: (schema: unknown) => schema,
}));

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  streamTextMock.mockClear();
});

describe("runAgentLoop", () => {
  it("sends the error hook when the model finishes with empty text", async () => {
    installHarnessEnv();
    const { runAgentLoop } = await import("../functions/harness-processing/harness.ts");
    const persistModelMessages = mock(async () => { });
    const onErrorText = mock(async () => { });

    const stream = await runAgentLoop({
      conversationKey: "tg:7495331456",
      eventId: "tg-900151472",
      persistModelMessages,
      loadRefreshedSystemPromptParts: async () => ({
        promptContext: { cursor: null, messages: [] },
        system: [],
      }),
    } as never, {
      messages: [{ role: "user", content: "hello" }],
      system: [],
      ephemeralSystem: [],
      hasPendingUserMessage: true,
      promptContext: { cursor: null, messages: [] },
    }, {
      onFinalText: async () => {
        throw new Error("unexpected final text");
      },
      onErrorText,
    });

    await stream.consumeStream();

    expect(stream.didFail()).toBe(true);
    expect(stream.failureText()).toBe("Model returned empty response");
    expect(onErrorText).toHaveBeenCalledWith("Model returned empty response");
  });
});

function installHarnessEnv(): void {
  process.env.GOOGLE_MODEL_ID = "gemini-test";
  process.env.GOOGLE_API_KEY = "google-key";
  process.env.MAX_AGENT_ITERATIONS = "3";
  process.env.TAVILY_API_KEY = "tavily-key";
  process.env.FILESYSTEM_BUCKET_NAME = "filesystem-bucket";
}
