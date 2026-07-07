/**
 * mergeSystemMessagesMiddleware: openai-compatible endpoints (OVH Qwen) return
 * an empty stream when a request carries more than one system message, so the
 * custom-provider path folds them into one.
 */

import { describe, expect, it } from "bun:test";
import { mergeSystemMessagesMiddleware } from "../src/harness/provider.ts";

type PromptMessage = { role: string; content: unknown };

async function transform(prompt: PromptMessage[]): Promise<PromptMessage[]> {
  const result = await mergeSystemMessagesMiddleware.transformParams!({
    params: { prompt } as never,
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
      { role: "system", content: "Base prompt.\n\n<skills>skill context</skills>" },
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
    const original = [{ role: "user", content: [{ type: "text", text: "hi" }] }];

    expect(await transform(original)).toEqual(original);
  });
});
