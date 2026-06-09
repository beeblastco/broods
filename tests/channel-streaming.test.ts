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

  it("progress mode previews tool activity then swaps in the final answer", async () => {
    const { actions, calls } = recordingActions(true);
    const writer = createChannelStreamWriter(actions, "progress", 0);

    await writer.push("streamed assistant text"); // progress mode ignores text deltas
    await writer.progress!("search");
    await writer.progress!("read");
    await writer.finish("Here is the answer.");

    const first = calls[0]!;
    expect(first[0]).toBe("beginMessage");
    expect(first[2]).toContain("⏳ Working…");
    expect(first[2]).toContain("• search");
    expect(calls.some(([op]) => op === "sendText")).toBe(false);     // text never streamed
    expect(calls.at(-1)).toEqual(["editMessage", "m1", "Here is the answer."]); // final swap
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
