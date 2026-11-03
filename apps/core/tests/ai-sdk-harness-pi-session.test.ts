import type { PiSessionStorage } from "@ai-sdk/harness-pi";
import type { BroodsSandboxDriver } from "@broods/ai-sdk-sandbox";
import { describe, expect, it, mock, spyOn } from "bun:test";
import { createPiSessionLog } from "../src/harness/ai-sdk-harness/adapters/pi.ts";
import { replaceReleasedMachine } from "../src/harness/ai-sdk-harness/sandbox.ts";
import { parkAiSdkHarnessSession } from "../src/harness/ai-sdk-harness/session.ts";
import { SandboxGoneError } from "../src/harness/sandbox/utils.ts";

type PiEntry = Parameters<PiSessionStorage["append"]>[0]["entry"];

const LEAF_STATE = {
  type: "resume-session",
  harnessId: "pi",
  specificationVersion: "harness-v1",
  data: { leafId: "e2" },
} as const;

describe("createPiSessionLog", () => {
  it("holds appended entries for the checkpoint save and reads them back", async () => {
    const log = createPiSessionLog(async () => []);
    await log.storage.appendMany!({
      sessionId: "s1",
      entries: [textEntry("e1", undefined, "hi"), textEntry("e2", "e1", "yo")],
    });

    const taken = log.take();
    expect(taken.map((entry) => [entry.entryId, entry.parentEntryId])).toEqual([
      ["e1", undefined],
      ["e2", "e1"],
    ]);
    expect(log.take()).toEqual([]);

    const reread = createPiSessionLog(async () => taken);
    expect(
      await reread.storage.read({ sessionId: "s1", leafId: "e2" }),
    ).toEqual([textEntry("e1", undefined, "hi"), textEntry("e2", "e1", "yo")]);
  });

  it("swaps an image over the size cap for a note instead of failing the save", async () => {
    const log = createPiSessionLog(async () => []);
    const entry = textEntry("e1", undefined, "see attached");
    entry.data = {
      ...entry.data,
      message: {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        content: [
          { type: "text", text: "image.png" },
          {
            type: "image",
            data: "A".repeat(900 * 1_024),
            mimeType: "image/png",
          },
        ],
        isError: false,
        timestamp: 1,
      },
    } as PiEntry["data"];
    await log.storage.append({ sessionId: "s1", entry: entry });

    const [stored] = log.take();
    expect(stored!.entry.length).toBeLessThan(1_024);
    expect(JSON.parse(stored!.entry).message.content).toEqual([
      { type: "text", text: "image.png" },
      {
        type: "text",
        text: "[900 KiB image cut: over the session history limit]",
      },
    ]);
  });

  it("refuses an entry it cannot trim under the cap", async () => {
    const log = createPiSessionLog(async () => []);

    expect(
      log.storage.append({
        sessionId: "s1",
        entry: textEntry("e1", undefined, "x".repeat(600 * 1_024)),
      }),
    ).rejects.toThrow("Pi session entry e1 is");
  });
});

describe("parkAiSdkHarnessSession with a Pi session log", () => {
  it("saves the entries Pi appended with the leaf id they lead to", async () => {
    const log = createPiSessionLog(async () => []);
    const saveHarnessSession = mock(async () => {});

    await parkAiSdkHarnessSession({
      broodsSession: { saveHarnessSession: saveHarnessSession } as never,
      nativeSession: {
        sessionId: "s1",
        stop: async () => {
          await log.storage.appendMany!({
            sessionId: "s1",
            entries: [
              textEntry("e1", undefined, "hi"),
              textEntry("e2", "e1", "yo"),
            ],
          });

          return LEAF_STATE;
        },
      } as never,
      reservationKey: "acct:a:agent:b:pi",
      sessionLog: log,
      successful: true,
      type: "pi",
    });

    const [state, entries] = saveHarnessSession.mock.calls[0] as unknown as [
      { resumeState: unknown },
      { entryId: string }[],
    ];
    expect(state.resumeState).toEqual(LEAF_STATE);
    expect(entries.map((entry) => entry.entryId)).toEqual(["e1", "e2"]);
  });
});

describe("replaceReleasedMachine", () => {
  it("resumes a Pi session on a fresh machine when its own was released", async () => {
    const fresh = { id: "fresh" };
    const driver = replaceReleasedMachine("pi", {
      createSession: async () => ({
        session: fresh as never,
        isFirstCreate: true,
      }),
      resumeSession: async () => {
        throw new SandboxGoneError("no reserved MicroVM");
      },
    });

    expect(await driver.resumeSession!({ sessionId: "s1" })).toBe(
      fresh as never,
    );
  });

  it("leaves other failures and machine-bound harnesses alone", async () => {
    const broken: BroodsSandboxDriver = {
      createSession: async () => {
        throw new Error("never");
      },
      resumeSession: async () => {
        throw new Error("network down");
      },
    };

    expect(replaceReleasedMachine("codex", broken)).toBe(broken);
    expect(
      replaceReleasedMachine("pi", broken).resumeSession!({ sessionId: "s1" }),
    ).rejects.toThrow("network down");
  });
});

describe("Session harness entries", () => {
  it("pages through every entry and saves new ones with the checkpoint", async () => {
    const { Session } = await import("../src/harness/session.ts");
    const { runtime } = await import("../src/shared/convex/runtime.ts");
    const row = (
      entryId: string,
    ): { entryId: string; version: number; entry: string } => ({
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
    const mutate = spyOn(runtime, "mutate").mockResolvedValue(null);
    try {
      const session = new Session({
        eventId: "event",
        conversationKey: "conversation",
        ownerGeneration: 2,
      });

      expect(
        (await session.readHarnessSessionEntries("s1")).map(
          (entry) => entry.entryId,
        ),
      ).toEqual(["e1", "e2"]);
      await session.saveHarnessSession(
        { harnessType: "pi", sessionId: "s1", resumeState: LEAF_STATE },
        [row("e3")],
      );
      expect(mutate.mock.calls[0]![1]).toMatchObject({
        sessionId: "s1",
        entries: [row("e3")],
      });
    } finally {
      query.mockRestore();
      mutate.mockRestore();
    }
  });
});

function textEntry(
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
