import { describe, expect, test } from "bun:test";
import type { ModelMessage } from "ai";
import {
  ATTACHMENT_NOT_RETAINED,
  createStoredEventFromModelMessage,
} from "../../../../apps/core/src/harness/session.ts";

type ToolOutput = Extract<
  ModelMessage,
  { role: "tool" }
>["content"][number] extends infer Part
  ? Part extends { output: infer Output }
    ? Output
    : never
  : never;

function toolMessage(output: ToolOutput): ModelMessage {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "call_1",
        toolName: "read",
        output: output,
      },
    ],
  };
}

function storedOutput(output: ToolOutput): unknown {
  const event = createStoredEventFromModelMessage(
    toolMessage(output),
    "source_1",
  );
  const message = event?.message as
    | { content: { type: string; output?: unknown }[] }
    | undefined;
  const part = message?.content[0];

  return part && part.type === "tool-result" ? part.output : undefined;
}

describe("a tool result is stored as the model saw it, minus bytes it cannot keep", (): void => {
  test.each<[string, ToolOutput]>([
    ["text", { type: "text", value: "ok" }],
    ["empty text", { type: "text", value: "" }],
    ["a number", { type: "json", value: 1 }],
    ["a string", { type: "json", value: "plain" }],
    ["null", { type: "json", value: null }],
    ["a list", { type: "json", value: [1, 2, 3] }],
    ["a one-key object", { type: "json", value: { a: 1 } }],
    ["an error text", { type: "error-text", value: "boom" }],
    ["an error object", { type: "error-json", value: { message: "x" } }],
    ["a denial", { type: "execution-denied", reason: "no" }],
    ["a denial without a reason", { type: "execution-denied" }],
    ["text content", { type: "content", value: [{ type: "text", text: "a" }] }],
    [
      "a remote file url",
      {
        type: "content",
        value: [{ type: "file-url", url: "https://x.test/a.pdf" }],
      },
    ],
    [
      "a remote image url",
      {
        type: "content",
        value: [{ type: "image-url", url: "https://x.test/a.png" }],
      },
    ],
    [
      "a sealed media link",
      {
        type: "content",
        value: [{ type: "file-url", url: "broods-media:abc" }],
      },
    ],
    [
      "a remote file reference",
      {
        type: "content",
        value: [
          {
            type: "file",
            mediaType: "image/png",
            data: { type: "url", url: new URL("https://x.test/b.png") },
          },
        ],
      },
    ],
  ])("%s is kept whole", (_name, output): void => {
    expect(storedOutput(output)).toEqual(output);
  });

  test.each<[string, ToolOutput]>([
    [
      "inline image bytes",
      {
        type: "content",
        value: [{ type: "image-data", data: "AAAA", mediaType: "image/png" }],
      },
    ],
    [
      "inline file bytes",
      {
        type: "content",
        value: [{ type: "file-data", data: "AAAA", mediaType: "text/plain" }],
      },
    ],
    [
      "a data: url",
      {
        type: "content",
        value: [{ type: "file-url", url: "data:text/plain;base64,AAAA" }],
      },
    ],
    [
      "inline file data",
      {
        type: "content",
        value: [
          {
            type: "file",
            mediaType: "text/plain",
            data: { type: "data", data: "AAAA" },
          },
        ],
      },
    ],
  ])("%s leaves a note in its place", (_name, output): void => {
    expect(storedOutput(output)).toEqual({
      type: "content",
      value: [{ type: "text", text: ATTACHMENT_NOT_RETAINED }],
    });
  });

  test("what can be kept stays beside the note-free remainder", (): void => {
    expect(
      storedOutput({
        type: "content",
        value: [
          { type: "text", text: "see" },
          { type: "image-data", data: "AAAA", mediaType: "image/png" },
        ],
      }),
    ).toEqual({ type: "content", value: [{ type: "text", text: "see" }] });
  });
});

describe("an assistant message is stored without what the next turn cannot use", (): void => {
  const reasoning = { type: "reasoning" as const, text: "hmm" };
  const text = { type: "text" as const, text: "hi" };
  const call = {
    type: "tool-call" as const,
    toolCallId: "c1",
    toolName: "read",
    input: {},
  };

  test.each<[string, ModelMessage["content"], boolean, unknown]>([
    ["plain text", "hello", false, "hello"],
    [
      "reasoning dropped when the model does not retain it",
      [reasoning, text],
      false,
      [text],
    ],
    ["reasoning kept when it does", [reasoning, text], true, [reasoning, text]],
    ["a tool call", [call], false, [call]],
    ["only reasoning, which leaves nothing", [reasoning], false, null],
    ["an empty list", [], true, null],
  ])("%s", (_name, content, retains, expected): void => {
    const event = createStoredEventFromModelMessage(
      { role: "assistant", content: content } as ModelMessage,
      "source_1",
      { model: "model-x", retainsReasoning: retains },
    );

    if (expected === null) {
      expect(event).toBeNull();

      return;
    }
    expect(event).toMatchObject({
      version: 1,
      sourceEventId: "source_1",
      model: "model-x",
      message: { role: "assistant", content: expected },
    });
  });
});

describe("the stored envelope", (): void => {
  test("a user message carries its hook metadata and drops its dedupe key", (): void => {
    const event = createStoredEventFromModelMessage(
      {
        role: "user",
        content: "hi",
        metadata: { from: "hook" },
        dedupeKey: "k",
      } as ModelMessage,
      "source_2",
    );

    expect(event).toEqual({
      version: 1,
      sourceEventId: "source_2",
      metadata: { from: "hook" },
      message: { role: "user", content: "hi" },
    });
  });

  test("a message with nothing left to store is no event", (): void => {
    expect(createStoredEventFromModelMessage(undefined, "source_3")).toBeNull();
    expect(
      createStoredEventFromModelMessage(
        { role: "tool", content: [] },
        "source_3",
      ),
    ).toBeNull();
  });
});
