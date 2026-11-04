import type { PiSessionStorage } from "@ai-sdk/harness-pi";
import { MAX_HARNESS_SESSION_ENTRY_BYTES } from "@broods/convex/model/harnessSessionEntries";
import { describe, expect, it, mock, spyOn } from "bun:test";
import { createPiSessionStorage } from "../src/harness/ai-sdk-harness/adapters/pi.ts";
import { openAiSdkHarnessSession } from "../src/harness/ai-sdk-harness/session.ts";
import { SandboxGoneError } from "../src/harness/sandbox/utils.ts";
import type { HarnessSessionEntry } from "../src/shared/convex/runtime.ts";

type PiEntry = Parameters<PiSessionStorage["append"]>[0]["entry"];

const LEAF_STATE = {
  type: "resume-session",
  harnessId: "pi",
  specificationVersion: "harness-v1",
  data: { leafId: "e2" },
} as const;

describe("createPiSessionStorage", () => {
  it("hands appended entries to the Broods session and reads them back", async () => {
    const appended: HarnessSessionEntry[] = [];
    const storage = createPiSessionStorage({
      appendHarnessSessionEntries: (entries): void => {
        appended.push(...entries);
      },
      readHarnessSessionEntries: async () => appended,
    });
    await storage.appendMany!({
      sessionId: "s1",
      entries: [userEntry("e1", undefined, "hi"), userEntry("e2", "e1", "yo")],
    });

    expect(
      appended.map((entry) => [entry.entryId, entry.parentEntryId]),
    ).toEqual([
      ["e1", undefined],
      ["e2", "e1"],
    ]);
    expect(await storage.read({ sessionId: "s1", leafId: "e2" })).toEqual([
      userEntry("e1", undefined, "hi"),
      userEntry("e2", "e1", "yo"),
    ]);
  });

  it("tags a compaction with the first entry its summary keeps", async () => {
    const appended: HarnessSessionEntry[] = [];
    const storage = createPiSessionStorage({
      appendHarnessSessionEntries: (entries): void => {
        appended.push(...entries);
      },
      readHarnessSessionEntries: async () => [],
    });
    const compaction = userEntry("c1", "e2", "");
    compaction.data = {
      type: "compaction",
      id: "c1",
      parentId: "e2",
      timestamp: "2026-11-03T00:00:00.000Z",
      summary: "earlier work",
      firstKeptEntryId: "e1",
      tokensBefore: 1_000,
    } as PiEntry["data"];
    await storage.appendMany!({
      sessionId: "s1",
      entries: [userEntry("e2", "e1", "yo"), compaction],
    });

    expect(appended.map((entry) => entry.firstKeptEntryId)).toEqual([
      undefined,
      "e1",
    ]);
  });

  it("trims every part kind of an oversized entry in one pass instead of failing", async () => {
    const appended: HarnessSessionEntry[] = [];
    const storage = createPiSessionStorage({
      appendHarnessSessionEntries: (entries): void => {
        appended.push(...entries);
      },
      readHarnessSessionEntries: async () => [],
    });
    const huge = "x".repeat(300 * 1_024);
    const assistant = userEntry("a1", undefined, "");
    assistant.data = {
      ...assistant.data,
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: huge },
          { type: "text", text: huge },
          {
            type: "toolCall",
            id: "call-1",
            name: "write",
            arguments: { path: "big.txt", content: huge },
          },
        ],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "toolUse",
        timestamp: 1,
      },
    } as PiEntry["data"];
    const image = userEntry("t1", "a1", "");
    image.data = {
      ...image.data,
      message: {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        content: [
          { type: "image", data: huge.repeat(2), mimeType: "image/png" },
        ],
        isError: false,
        timestamp: 1,
      },
    } as PiEntry["data"];

    await storage.appendMany!({
      sessionId: "s1",
      entries: [assistant, image, userEntry("u1", "t1", huge.repeat(2))],
    });

    expect(appended).toHaveLength(3);
    for (const entry of appended) {
      expect(Buffer.byteLength(entry.entry)).toBeLessThan(
        MAX_HARNESS_SESSION_ENTRY_BYTES,
      );
    }
    expect(appended[0]!.entry).toContain('"path":"big.txt"');
    expect(appended[0]!.entry).toContain("[output truncated]");
    expect(JSON.parse(appended[1]!.entry).message.content).toEqual([
      { type: "text", text: "[attachment not retained]" },
    ]);
    expect(appended[2]!.entry).toContain("[output truncated]");
  });
});

describe("openAiSdkHarnessSession for Pi", () => {
  it("resumes the stored Pi session on a fresh machine when its own was released", async () => {
    const fresh = { id: "fresh-machine" };
    const createSandbox = mock(async () => fresh);
    const createSession = mock(async () => ({ sessionId: "pi-session" }));
    const warn = spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const opened = await openAiSdkHarnessSession({
        abortSignal: new AbortController().signal,
        agent: { createSession: createSession } as never,
        sandbox: {
          createSession: createSandbox,
          resumeSession: async (): Promise<never> => {
            throw new SandboxGoneError("no reserved MicroVM");
          },
        } as never,
        stored: {
          harnessType: "pi",
          sessionId: "pi-session",
          resumeState: LEAF_STATE,
        },
        type: "pi",
      });

      expect(createSandbox).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: "pi-session" }),
      );
      expect(createSession).toHaveBeenLastCalledWith(
        expect.objectContaining({
          sessionId: "pi-session",
          resumeFrom: LEAF_STATE,
          sandboxSession: fresh,
        }),
      );
      expect(opened.sandboxSession).toBe(fresh as never);
      expect(JSON.stringify(warn.mock.calls)).toContain("fresh machine");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("Session harness entries", () => {
  it("stages a turn's entries in bounded batches before the checkpoint save", async () => {
    const { Session } = await import("../src/harness/session.ts");
    const { runtime } = await import("../src/shared/convex/runtime.ts");
    const mutate = spyOn(runtime, "mutate").mockImplementation((async (
      name: string,
    ) => (name === "appendHarnessSessionEntries" ? 7 : null)) as never);
    try {
      const session = new Session({
        eventId: "event",
        conversationKey: "conversation",
        ownerGeneration: 2,
      });
      session.appendHarnessSessionEntries(
        Array.from({ length: 12 }, (_, index) => ({
          entryId: `e${index}`,
          version: 3,
          entry: "x".repeat(500 * 1_024),
        })),
      );
      await session.saveHarnessSession({
        harnessType: "pi",
        sessionId: "s1",
        resumeState: LEAF_STATE,
      });

      const calls = mutate.mock.calls.map(([name]) => name);
      expect(calls.at(-1)).toBe("saveHarnessSession");
      expect(
        calls.filter((name) => name === "appendHarnessSessionEntries").length,
      ).toBeGreaterThan(0);
      expect(mutate.mock.calls.at(-1)![1]).toMatchObject({ afterSequence: 7 });
      const sent = mutate.mock.calls.flatMap(
        ([, args]) =>
          (args as { entries?: { entryId: string }[] }).entries ?? [],
      );
      expect(sent.map((entry) => entry.entryId)).toEqual(
        Array.from({ length: 12 }, (_, index) => `e${index}`),
      );

      mutate.mockClear();
      await session.saveHarnessSession({
        harnessType: "pi",
        sessionId: "s1",
        resumeState: LEAF_STATE,
      });
      expect(mutate.mock.calls.map(([name]) => name)).toEqual([
        "saveHarnessSession",
      ]);
      expect(mutate.mock.calls[0]![1]).toMatchObject({ entries: [] });
    } finally {
      mutate.mockRestore();
    }
  });

  it("pages through the leaf's context window", async () => {
    const { Session } = await import("../src/harness/session.ts");
    const { runtime } = await import("../src/shared/convex/runtime.ts");
    const row = (entryId: string): HarnessSessionEntry => ({
      entryId: entryId,
      version: 3,
      entry: "{}",
    });
    const query = spyOn(runtime, "query").mockImplementation((async (
      _name: string,
      args: { afterSequence?: number },
    ) =>
      args.afterSequence === undefined
        ? { entries: [row("e1")], nextSequence: 1 }
        : { entries: [row("e2")], nextSequence: null }) as never);
    try {
      const session = new Session({
        eventId: "event",
        conversationKey: "conversation",
      });

      expect(
        (await session.readHarnessSessionEntries("s1", "e2")).map(
          (entry) => entry.entryId,
        ),
      ).toEqual(["e1", "e2"]);
      expect(query.mock.calls.map(([, args]) => args)).toEqual([
        { conversationKey: "conversation", sessionId: "s1", leafEntryId: "e2" },
        {
          conversationKey: "conversation",
          sessionId: "s1",
          leafEntryId: "e2",
          afterSequence: 1,
        },
      ]);
    } finally {
      query.mockRestore();
    }
  });
});

function userEntry(
  entryId: string,
  parentEntryId: string | undefined,
  text: string,
): PiEntry {
  return {
    entryId: entryId,
    parentEntryId: parentEntryId,
    version: 3,
    data: {
      type: "message",
      id: entryId,
      parentId: parentEntryId ?? null,
      timestamp: "2026-11-03T00:00:00.000Z",
      message: { role: "user", content: text, timestamp: 1 },
    } as PiEntry["data"],
  };
}
