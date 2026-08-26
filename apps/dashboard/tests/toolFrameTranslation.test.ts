import { describe, expect, test } from "bun:test";
import { toUiMessageChunk } from "../app/hooks/useAgentChat";

/**
 * Ground truth: frames captured live from the deployed runtime (ticket 14
 * frame dump, conversation chat-t14-tool-probe-2). The runtime emits
 * `streamText` full-stream parts; the AI SDK's `uiMessageChunkSchema` accepts
 * only UI chunks, so before the translation every one of these was silently
 * dropped and tool use was invisible in the chat.
 */
const CAPTURED_TOOL_INPUT_START = {
  type: "tool-input-start",
  id: "call_630750",
  toolName: "list_schedules",
};
const CAPTURED_TOOL_INPUT_DELTA = {
  type: "tool-input-delta",
  id: "call_630750",
  delta: "{}",
};
const CAPTURED_TOOL_CALL = {
  type: "tool-call",
  toolCallId: "call_630750",
  toolName: "list_schedules",
  input: {},
  dynamic: true,
};
const CAPTURED_TOOL_ERROR = {
  type: "tool-error",
  toolCallId: "call_630750",
  toolName: "list_schedules",
  input: {},
  error:
    "AI_NoSuchToolError: Model tried to call unavailable tool 'list_schedules'. No tools are available.",
  dynamic: true,
};

describe("toUiMessageChunk tool frames", () => {
  test("tool-input-start: call id moves from `id` to `toolCallId`", () => {
    expect(toUiMessageChunk(CAPTURED_TOOL_INPUT_START)).toEqual({
      type: "tool-input-start",
      toolCallId: "call_630750",
      toolName: "list_schedules",
    });
  });

  test("tool-input-delta: renames `id`/`delta` to `toolCallId`/`inputTextDelta`", () => {
    expect(toUiMessageChunk(CAPTURED_TOOL_INPUT_DELTA)).toEqual({
      type: "tool-input-delta",
      toolCallId: "call_630750",
      inputTextDelta: "{}",
    });
  });

  test("tool-call becomes tool-input-available", () => {
    expect(toUiMessageChunk(CAPTURED_TOOL_CALL)).toEqual({
      type: "tool-input-available",
      toolCallId: "call_630750",
      toolName: "list_schedules",
      input: {},
      dynamic: true,
    });
  });

  test("tool-result becomes tool-output-available", () => {
    expect(
      toUiMessageChunk({
        type: "tool-result",
        toolCallId: "call_630750",
        toolName: "list_schedules",
        input: {},
        output: { schedules: [] },
        dynamic: true,
      }),
    ).toEqual({
      type: "tool-output-available",
      toolCallId: "call_630750",
      toolName: "list_schedules",
      input: {},
      output: { schedules: [] },
      dynamic: true,
    });
  });

  test("tool-error becomes tool-output-error with a string errorText", () => {
    const chunk = toUiMessageChunk(CAPTURED_TOOL_ERROR);
    expect(chunk.type).toBe("tool-output-error");
    expect(chunk.toolCallId).toBe("call_630750");
    expect(chunk.errorText).toContain("AI_NoSuchToolError");
    expect("error" in chunk).toBe(false);
  });

  test("tool-error with a non-string error payload is stringified", () => {
    const chunk = toUiMessageChunk({
      type: "tool-error",
      toolCallId: "call_1",
      error: { code: "boom" },
    });
    expect(chunk.errorText).toBe('{"code":"boom"}');
  });

  test("tool-input-end passes through untouched (no UI equivalent)", () => {
    const part = { type: "tool-input-end", id: "call_630750" };
    expect(toUiMessageChunk(part)).toBe(part);
  });
});

describe("toUiMessageChunk existing translations stay intact", () => {
  test("text-delta renames `text` to `delta`", () => {
    expect(
      toUiMessageChunk({ type: "text-delta", id: "0", text: "hi" }),
    ).toEqual({ type: "text-delta", id: "0", delta: "hi" });
  });

  test("error renames `error` to `errorText`", () => {
    expect(toUiMessageChunk({ type: "error", error: "boom" })).toEqual({
      type: "error",
      errorText: "boom",
    });
  });

  test("already-conforming chunks pass through", () => {
    const part = { type: "text-start", id: "0" };
    expect(toUiMessageChunk(part)).toBe(part);
  });
});
