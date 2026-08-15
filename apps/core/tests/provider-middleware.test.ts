/**
 * Custom-provider middlewares for openai-compatible endpoint (OVH Qwen)
 * quirks: mergeSystemMessagesMiddleware folds multiple system messages into
 * one (extras return an empty stream), and normalizeStreamDeltasMiddleware
 * rewrites cumulative-snapshot deltas to increments and back-fills missing
 * reasoning-token usage. retryWithoutStoredItemsMiddleware covers the OpenAI
 * Responses path, where a replayed item reference can go stale.
 */

import { APICallError } from "@ai-sdk/provider";
import { describe, expect, it } from "bun:test";
import {
  mergeSystemMessagesMiddleware,
  normalizeStreamDeltasMiddleware,
  retryWithoutStoredItemsMiddleware,
} from "../src/harness/provider.ts";

type PromptMessage = { role: string; content: unknown };

async function transform(prompt: PromptMessage[]): Promise<PromptMessage[]> {
  const result = await mergeSystemMessagesMiddleware.transformParams!({
    params: { prompt: prompt } as never,
    type: "stream",
    model: {} as never,
  });

  return (result as { prompt: PromptMessage[] }).prompt;
}

describe("mergeSystemMessagesMiddleware", () => {
  it("folds multiple system messages into one leading message", async () => {
    const prompt = await transform([
      { role: "system", content: "Base prompt." },
      { role: "system", content: "<skills>skill context</skills>" },
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]);

    expect(prompt).toEqual([
      {
        role: "system",
        content: "Base prompt.\n\n<skills>skill context</skills>",
      },
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]);
  });

  it("leaves a single system message untouched", async () => {
    const original = [
      { role: "system", content: "Only one." },
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ];

    expect(await transform(original)).toEqual(original);
  });

  it("passes through prompts without system messages", async () => {
    const original = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ];

    expect(await transform(original)).toEqual(original);
  });
});

type StreamPart = Record<string, unknown>;

async function runStream(parts: StreamPart[]): Promise<StreamPart[]> {
  const { stream } = (await normalizeStreamDeltasMiddleware.wrapStream!({
    doStream: async () => ({
      stream: new ReadableStream<StreamPart>({
        start: function(controller) {
          for (const part of parts) controller.enqueue(part);
          controller.close();
        },
      }),
    }),
  } as never)) as { stream: ReadableStream<StreamPart> };

  const emitted: StreamPart[] = [];
  for await (const part of stream) {
    emitted.push(part);
  }

  return emitted;
}

const finishPart = (outputTokens: {
  total?: number;
  text?: number;
  reasoning?: number;
}): StreamPart => ({
  type: "finish",
  finishReason: "stop",
  usage: {
    inputTokens: {
      total: 10,
      noCache: 10,
      cacheRead: 0,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: undefined,
      text: undefined,
      reasoning: undefined,
      ...outputTokens,
    },
  },
});

describe("normalizeStreamDeltasMiddleware", () => {
  it("rewrites cumulative snapshot deltas to their new suffix", async () => {
    const emitted = await runStream([
      { type: "reasoning-delta", id: "r0", delta: "The" },
      { type: "reasoning-delta", id: "r0", delta: "The user is" },
      { type: "reasoning-delta", id: "r0", delta: "The user is asking" },
    ]);

    expect(emitted.map((part) => part.delta)).toEqual([
      "The",
      " user is",
      " asking",
    ]);
  });

  it("drops pure snapshot repeats and passes true increments through", async () => {
    const emitted = await runStream([
      { type: "text-delta", id: "t0", delta: "Hello" },
      { type: "text-delta", id: "t0", delta: "Hello" },
      { type: "text-delta", id: "t0", delta: ", world" },
    ]);

    expect(emitted.map((part) => part.delta)).toEqual(["Hello", ", world"]);
  });

  it("tracks accumulation per part id", async () => {
    const emitted = await runStream([
      { type: "reasoning-delta", id: "r0", delta: "abc" },
      { type: "text-delta", id: "t0", delta: "abcdef" },
    ]);

    expect(emitted.map((part) => part.delta)).toEqual(["abc", "abcdef"]);
  });

  it("estimates missing reasoning tokens from the character share", async () => {
    const emitted = await runStream([
      { type: "reasoning-delta", id: "r0", delta: "x".repeat(300) },
      { type: "text-delta", id: "t0", delta: "y".repeat(100) },
      finishPart({ total: 200, text: 200, reasoning: 0 }),
    ]);

    const finish = emitted.at(-1) as {
      usage: { outputTokens: Record<string, number> };
    };
    expect(finish.usage.outputTokens).toEqual({
      total: 200,
      text: 50,
      reasoning: 150,
    });
  });

  it("keeps provider-reported reasoning tokens untouched", async () => {
    const finish = finishPart({ total: 200, text: 120, reasoning: 80 });
    const emitted = await runStream([
      { type: "reasoning-delta", id: "r0", delta: "thinking" },
      finish,
    ]);

    expect(emitted.at(-1)).toEqual(finish);
  });

  it("leaves usage alone when no reasoning streamed", async () => {
    const finish = finishPart({ total: 50, text: 50, reasoning: 0 });
    const emitted = await runStream([
      { type: "text-delta", id: "t0", delta: "plain answer" },
      finish,
    ]);

    expect(emitted.at(-1)).toEqual(finish);
  });
});

const storedItemPrompt = [
  { role: "user", content: [{ type: "text", text: "who are our customers?" }] },
  {
    role: "assistant",
    content: [
      {
        type: "reasoning",
        text: "",
        providerOptions: { openai: { itemId: "rs_1" } },
      },
      {
        type: "text",
        text: "answer",
        providerOptions: { openai: { itemId: "msg_1", phase: "final" } },
      },
    ],
  },
] as never;

const apiCallError = (message: string): APICallError =>
  new APICallError({
    message: message,
    url: "https://api.openai.com/v1/responses",
    requestBodyValues: {},
    statusCode: 400,
  });

// Drives the middleware with a first call that always throws, so the assertion
// is on whether a retry happened and what prompt it carried.
async function retryPrompt(error: unknown): Promise<{
  retried: boolean;
  prompt?: unknown;
}> {
  let retried: { prompt: unknown } | undefined;

  await retryWithoutStoredItemsMiddleware.wrapStream!({
    doStream: async () => {
      throw error;
    },
    model: {
      doStream: async (params: { prompt: unknown }) => {
        retried = { prompt: params.prompt };

        return { stream: new ReadableStream() };
      },
    },
    params: { prompt: storedItemPrompt },
  } as never);

  return { retried: retried !== undefined, prompt: retried?.prompt };
}

describe("retryWithoutStoredItemsMiddleware", () => {
  it("retries without reasoning parts or item ids when a reference is unpaired", async () => {
    const { retried, prompt } = await retryPrompt(
      apiCallError(
        "Item 'msg_1' of type 'message' was provided without its required 'reasoning' item: 'rs_1'.",
      ),
    );

    expect(retried).toBe(true);
    expect(prompt).toEqual([
      storedItemPrompt[0],
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "answer",
            providerOptions: { openai: { phase: "final" } },
          },
        ],
      },
    ]);
  });

  it("retries when a referenced item has aged out of the store", async () => {
    const { retried } = await retryPrompt(
      apiCallError("Item with id 'rs_1' not found."),
    );

    expect(retried).toBe(true);
  });

  it("retries when reasoning was encrypted for another model", async () => {
    const { retried } = await retryPrompt(
      apiCallError("invalid_encrypted_content"),
    );

    expect(retried).toBe(true);
  });

  it("rethrows an unrelated failure instead of paying for a second call", async () => {
    await expect(
      retryPrompt(apiCallError("Rate limit reached for gpt-5.6")),
    ).rejects.toThrow("Rate limit reached");
  });
});
