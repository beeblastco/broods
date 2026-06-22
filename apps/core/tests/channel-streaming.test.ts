/**
 * Channel streaming driver tests.
 * Cover edit-in-place, paragraph chunking, and the chunk fallback when a channel
 * has no edit primitives.
 */

import { describe, expect, it } from "bun:test";
import { createChannelStreamWriter } from "../functions/_shared/channel-streaming.ts";
import type { ChannelActions } from "../functions/_shared/channels.ts";

function recordingActions(withEdit: boolean) {
  const calls: Array<[string, ...string[]]> = [];
  let nextId = 1;
  const actions: ChannelActions = {
    sendText: async (text) => { calls.push(["sendText", text]); },
    sendTyping: async () => {},
    reactToMessage: async () => {},
    ...(withEdit
      ? {
        beginMessage: async (text: string) => { const id = `m${nextId++}`; calls.push(["beginMessage", id, text]); return id; },
        editMessage: async (id: string, text: string) => { calls.push(["editMessage", id, text]); },
      }
      : {}),
  };
  return { actions, calls };
}

describe("createChannelStreamWriter", () => {
  it("edit mode posts once then edits in place, ending with the final text", async () => {
    const { actions, calls } = recordingActions(true);
    const writer = createChannelStreamWriter(actions, "edit", 0); // throttle 0 => flush each push

    await writer.push("Hello");
    await writer.push(" world");
    await writer.finish("Hello world!");

    expect(calls[0]).toEqual(["beginMessage", "m1", "Hello"]);
    expect(calls.some(([op]) => op === "editMessage")).toBe(true);
    expect(calls.at(-1)).toEqual(["editMessage", "m1", "Hello world!"]);
    expect(calls.some(([op]) => op === "sendText")).toBe(false);
  });

  it("edit mode rotates into a new message when the reply outgrows the char cap", async () => {
    const { actions, calls } = recordingActions(true);
    const writer = createChannelStreamWriter(actions, "edit", 0, 20); // 20-char cap forces rotation

    await writer.push("AAAAAAAA\n\nBBBBBBBB");            // 18 chars: one message
    await writer.push("\n\nCCCCCCCC");                     // 28 chars total: rotate at the break
    await writer.finish("AAAAAAAA\n\nBBBBBBBB\n\nCCCCCCCC");

    const begins = calls.filter(([op]) => op === "beginMessage").map((c) => c[2]);
    expect(begins.length).toBe(2);                         // two messages => rotation happened
    expect(begins[0]).toBe("AAAAAAAA\n\nBBBBBBBB");         // first frozen at the paragraph break
    expect(begins[1]).toBe("CCCCCCCC");                    // remainder continues in a fresh message
    expect(calls.some(([op]) => op === "sendText")).toBe(false);
  });

  it("chunk mode sends each completed paragraph and flushes the remainder on finish", async () => {
    const { actions, calls } = recordingActions(true);
    const writer = createChannelStreamWriter(actions, "chunk");

    await writer.push("First para");
    await writer.push("graph.\n\nSecond paragraph.");
    await writer.push("\n\nThird");
    await writer.finish();

    expect(calls).toEqual([
      ["sendText", "First paragraph."],
      ["sendText", "Second paragraph."],
      ["sendText", "Third"],
    ]);
  });

  it("progress mode shows the status, then the answer takes over the same message", async () => {
    const { actions, calls } = recordingActions(true);
    const writer = createChannelStreamWriter(actions, "progress", 0);

    await writer.reasoning!("thinking about it");
    await writer.progress!("search");           // status: reasoning + tool, in one preview
    await writer.push("Here is ");               // answer takes over the SAME message
    await writer.push("the answer.");
    await writer.finish("Here is the answer.");

    // One live preview for the whole turn — never a message per block.
    expect(calls.filter(([op]) => op === "beginMessage").length).toBe(1);
    expect(calls.some(([op]) => op === "sendText")).toBe(false);
    // The status (header + reasoning + tool) was shown while the model worked…
    expect(calls.some((c) => c[2]?.includes("⏳ Working…") && c[2]?.includes("💭 thinking about it") && c[2]?.includes("• search"))).toBe(true);
    // …then the same message finalized in place to the answer, with no status left.
    expect(calls.at(-1)).toEqual(["editMessage", "m1", "Here is the answer."]);
  });

  it("progress mode ends on the final answer, dropping the working status (subagent dispatch case)", async () => {
    const { actions, calls } = recordingActions(true);
    const writer = createChannelStreamWriter(actions, "progress", 0);

    await writer.reasoning!("delegating research");
    await writer.progress!("run_subagent: Research ZeroFS");
    await writer.push("I'll dispatch a research task.");
    await writer.finish("ZeroFS is a filesystem.");

    // Single preview; the working status and pre-tool text are transient, the final
    // answer wins in place.
    expect(calls.filter(([op]) => op === "beginMessage").length).toBe(1);
    expect(calls.at(-1)).toEqual(["editMessage", "m1", "ZeroFS is a filesystem."]);
  });

  it("progress mode drops back to the status when a new tool runs after text", async () => {
    const { actions, calls } = recordingActions(true);
    const writer = createChannelStreamWriter(actions, "progress", 0);

    await writer.push("Step one narration");     // answer view
    await writer.progress!("bash: ls");           // new step -> status view, prior text reset
    await writer.finish("Final answer.");

    expect(calls.filter(([op]) => op === "beginMessage").length).toBe(1);
    // After the tool call the preview returned to the status, not the step-one text.
    expect(calls.some((c) => c[2]?.includes("⏳ Working…") && c[2]?.includes("• bash: ls"))).toBe(true);
    expect(calls.at(-1)).toEqual(["editMessage", "m1", "Final answer."]);
  });

  it("progress mode collapses reasoning to one compact line", async () => {
    const { actions, calls } = recordingActions(true);
    const writer = createChannelStreamWriter(actions, "progress", 0);

    await writer.reasoning!("Thinking about");
    await writer.reasoning!(" the labs\nand dates"); // newlines collapse to one line
    await writer.push("Answer text");
    await writer.finish("Answer text");

    expect(calls.some((call) => call[2]?.includes("💭 Thinking about the labs and dates"))).toBe(true);
    expect(calls.at(-1)).toEqual(["editMessage", "m1", "Answer text"]);
  });

  it("progress mode streams a plain text answer as one clean message, reconciled on finish", async () => {
    const { actions, calls } = recordingActions(true);
    const writer = createChannelStreamWriter(actions, "progress", 0);

    await writer.push("first token");
    await writer.push(" more tokens");
    // No stepFinish: the text block is still open, so finish() reconciles it to the
    // authoritative final text in place.
    await writer.finish("first token more tokens.");

    expect(calls[0]).toEqual(["beginMessage", "m1", "first token"]); // no work header for a text-only turn
    expect(calls.at(-1)).toEqual(["editMessage", "m1", "first token more tokens."]);
    expect(calls.filter(([op]) => op === "beginMessage").length).toBe(1); // single message
  });

  it("chunk mode flushes unfinished text at each model step", async () => {
    const { actions, calls } = recordingActions(false);
    const writer = createChannelStreamWriter(actions, "chunk", 0);

    await writer.push("step one without a paragraph");
    await writer.stepFinish!();
    await writer.push("step two");
    await writer.stepFinish!();
    await writer.finish("ignored authoritative accumulation");

    expect(calls).toEqual([
      ["sendText", "step one without a paragraph"],
      ["sendText", "step two"],
    ]);
  });

  it("chunk mode keeps a code fence whole instead of splitting on its inner blank line", async () => {
    const { actions, calls } = recordingActions(false);
    const writer = createChannelStreamWriter(actions, "chunk");

    await writer.push("Intro paragraph.\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\nOutro.");
    await writer.finish();

    expect(calls).toEqual([
      ["sendText", "Intro paragraph."],
      ["sendText", "```js\nconst a = 1;\n\nconst b = 2;\n```"],
      ["sendText", "Outro."],
    ]);
  });

  it("progress mode falls back to chunk when the channel has no edit primitives", async () => {
    const { actions, calls } = recordingActions(false);
    const writer = createChannelStreamWriter(actions, "progress", 0);

    expect(writer.progress).toBeUndefined();          // no status preview available
    await writer.push("alpha\n\nbeta");                // text streams as chunks instead
    await writer.finish();

    expect(calls).toEqual([["sendText", "alpha"], ["sendText", "beta"]]);
  });

  it("falls back to chunk mode when the channel has no edit primitives", async () => {
    const { actions, calls } = recordingActions(false);
    const writer = createChannelStreamWriter(actions, "edit", 0);

    await writer.push("alpha\n\n");
    await writer.finish();

    expect(calls).toEqual([["sendText", "alpha"]]);
  });
});
