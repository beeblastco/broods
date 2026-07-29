/**
 * AI SDK Harness session composition over Broods durability.
 */

import { describe, expect, it, mock } from "bun:test";
import {
  openAiSdkHarnessSession,
  parkAiSdkHarnessSession,
} from "../src/harness/ai-sdk-harness/index.ts";

const CHECKPOINT = {
  type: "resume-session",
  harnessId: "codex",
  specificationVersion: "harness-v1",
  data: { threadId: "thread-1" },
} as const;

describe("openAiSdkHarnessSession", () => {
  it("resumes the native session from the Broods checkpoint", async () => {
    const createSession = mock(async () => ({ sessionId: "native-session" }));
    const broodsSession = {
      loadHarnessSession: async () => ({
        harnessType: "codex",
        sessionId: "native-session",
        resumeState: CHECKPOINT,
      }),
    };
    const abortController = new AbortController();

    await openAiSdkHarnessSession({
      abortSignal: abortController.signal,
      agent: { createSession: createSession } as never,
      broodsSession: broodsSession as never,
      type: "codex",
    });

    expect(createSession).toHaveBeenCalledWith({
      sessionId: "native-session",
      resumeFrom: CHECKPOINT,
      abortSignal: abortController.signal,
    });
  });

  it("refuses to bind a conversation to another adapter", async () => {
    const createSession = mock(async () => ({ sessionId: "unused" }));
    const broodsSession = {
      loadHarnessSession: async () => ({
        harnessType: "pi",
        sessionId: "native-session",
        resumeState: {},
      }),
    };

    await expect(
      openAiSdkHarnessSession({
        abortSignal: new AbortController().signal,
        agent: { createSession: createSession } as never,
        broodsSession: broodsSession as never,
        type: "codex",
      }),
    ).rejects.toThrow(
      "Conversation is already bound to the pi harness; clear it before switching to codex",
    );
    expect(createSession).not.toHaveBeenCalled();
  });
});

describe("parkAiSdkHarnessSession", () => {
  it("detaches successful Deep Agents sessions before saving", async () => {
    const detach = mock(async () => CHECKPOINT);
    const stop = mock(async () => CHECKPOINT);
    const saveHarnessSession = mock(async () => {});
    const broodsSession = {
      assertCurrentOwner: async () => {},
      saveHarnessSession: saveHarnessSession,
    };

    await parkAiSdkHarnessSession({
      broodsSession: broodsSession as never,
      nativeSession: {
        sessionId: "native-session",
        detach: detach,
        stop: stop,
      } as never,
      successful: true,
      type: "deepagents",
    });

    expect(detach).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
    expect(saveHarnessSession).toHaveBeenCalledWith({
      harnessType: "deepagents",
      sessionId: "native-session",
      resumeState: CHECKPOINT,
    });
  });

  it("stops snapshot-backed adapters after successful turns", async () => {
    const detach = mock(async () => CHECKPOINT);
    const stop = mock(async () => CHECKPOINT);

    await parkAiSdkHarnessSession({
      broodsSession: {
        assertCurrentOwner: async () => {},
        saveHarnessSession: async () => {},
      } as never,
      nativeSession: {
        sessionId: "native-session",
        detach: detach,
        stop: stop,
      } as never,
      successful: true,
      type: "codex",
    });

    expect(detach).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("stops failed sessions instead of leaving live compute", async () => {
    const detach = mock(async () => CHECKPOINT);
    const stop = mock(async () => CHECKPOINT);

    await parkAiSdkHarnessSession({
      broodsSession: {
        assertCurrentOwner: async () => {},
        saveHarnessSession: async () => {},
      } as never,
      nativeSession: {
        sessionId: "native-session",
        detach: detach,
        stop: stop,
      } as never,
      successful: false,
      type: "deepagents",
    });

    expect(detach).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
