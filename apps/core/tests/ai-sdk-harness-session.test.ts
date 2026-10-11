import { describe, expect, it, mock, spyOn } from "bun:test";
import {
  harnessReservationKey,
  openAiSdkHarnessSession,
  parkAiSdkHarnessSession,
} from "../src/harness/ai-sdk-harness/session.ts";
import { SandboxGoneError } from "../src/harness/sandbox/utils.ts";

const CHECKPOINT = {
  type: "resume-session",
  harnessId: "codex",
  specificationVersion: "harness-v1",
  data: { threadId: "thread-1" },
} as const;

describe("openAiSdkHarnessSession", () => {
  it("resumes the native session from the Broods checkpoint", async () => {
    const createSession = mock(async () => ({ sessionId: "native-session" }));
    const abortController = new AbortController();

    await openAiSdkHarnessSession({
      abortSignal: abortController.signal,
      agent: { createSession: createSession } as never,
      stored: {
        harnessType: "codex",
        sessionId: "native-session",
        resumeState: CHECKPOINT,
      },
      type: "codex",
    });

    expect(createSession).toHaveBeenCalledWith({
      sessionId: "native-session",
      resumeFrom: CHECKPOINT,
      abortSignal: abortController.signal,
    });
  });

  it("starts fresh when the stored session's machine was released", async () => {
    const createSession = mock(async (options: { resumeFrom?: unknown }) => {
      if (options.resumeFrom) {
        throw new SandboxGoneError("no reserved workdir sandbox");
      }

      return { sessionId: "fresh" };
    });

    const session = await openAiSdkHarnessSession({
      abortSignal: new AbortController().signal,
      agent: { createSession: createSession } as never,
      stored: {
        harnessType: "codex",
        sessionId: "native-session",
        resumeState: CHECKPOINT,
      },
      type: "codex",
    });

    expect(session).toMatchObject({ sessionId: "fresh" });
    expect(createSession).toHaveBeenCalledTimes(2);
  });

  it("refuses to bind a conversation to another adapter", async () => {
    const createSession = mock(async () => ({ sessionId: "unused" }));
    expect(
      openAiSdkHarnessSession({
        abortSignal: new AbortController().signal,
        agent: { createSession: createSession } as never,
        stored: {
          harnessType: "pi",
          sessionId: "native-session",
          resumeState: {},
        },
        type: "codex",
      }),
    ).rejects.toThrow(
      "Conversation is already bound to the pi harness; clear it before switching to codex",
    );
    expect(createSession).not.toHaveBeenCalled();
  });
});

describe("harnessReservationKey", () => {
  const base = {
    agentReservationKey: "agent-machine",
    conversationKey: "conversation",
    isolated: false,
    stored: null,
  };

  it("shares the agent's machine for a new Pi conversation", () => {
    expect(harnessReservationKey({ ...base, type: "pi" })).toBe(
      "agent-machine",
    );
  });

  it("gives an isolated task its own machine", () => {
    expect(harnessReservationKey({ ...base, isolated: true, type: "pi" })).toBe(
      "conversation",
    );
  });

  it("keeps bridge adapters on one machine per conversation", () => {
    expect(harnessReservationKey({ ...base, type: "codex" })).toBe(
      "conversation",
    );
  });

  it("resumes on the machine the conversation started on", () => {
    const stored = {
      harnessType: "pi" as const,
      sessionId: "s",
      resumeState: {},
    };

    expect(
      harnessReservationKey({
        ...base,
        stored: { ...stored, reservationKey: "agent-machine" },
        isolated: true,
        type: "pi",
      }),
    ).toBe("agent-machine");
    expect(harnessReservationKey({ ...base, stored: stored, type: "pi" })).toBe(
      "conversation",
    );
  });
});

describe("parkAiSdkHarnessSession", () => {
  it("detaches successful Deep Agents sessions before saving", async () => {
    const detach = mock(async () => CHECKPOINT);
    const stop = mock(async () => CHECKPOINT);
    const saveHarnessSession = mock(async () => {});
    const broodsSession = {
      saveHarnessSession: saveHarnessSession,
    };

    await parkAiSdkHarnessSession({
      broodsSession: broodsSession as never,
      nativeSession: {
        sessionId: "native-session",
        detach: detach,
        stop: stop,
      } as never,
      reservationKey: "acct:a:agent:b:sandbox",
      successful: true,
      type: "deepagents",
    });

    expect(detach).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
    expect(saveHarnessSession).toHaveBeenCalledWith({
      harnessType: "deepagents",
      sessionId: "native-session",
      resumeState: CHECKPOINT,
      reservationKey: "acct:a:agent:b:sandbox",
    });
  });

  it("stops snapshot-backed adapters after successful turns", async () => {
    const detach = mock(async () => CHECKPOINT);
    const stop = mock(async () => CHECKPOINT);

    await parkAiSdkHarnessSession({
      broodsSession: {
        saveHarnessSession: async () => {},
      } as never,
      nativeSession: {
        sessionId: "native-session",
        detach: detach,
        stop: stop,
      } as never,
      reservationKey: "acct:a:agent:b:sandbox",
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
        saveHarnessSession: async () => {},
      } as never,
      nativeSession: {
        sessionId: "native-session",
        detach: detach,
        stop: stop,
      } as never,
      reservationKey: "acct:a:agent:b:sandbox",
      successful: false,
      type: "deepagents",
    });

    expect(detach).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledTimes(1);
  });
});

describe("Session.saveHarnessSession", () => {
  const state = {
    harnessType: "codex",
    sessionId: "native-session",
    resumeState: CHECKPOINT,
    reservationKey: "acct:a:agent:b:sandbox",
  } as const;

  async function saved(options: {
    ownerGeneration?: number;
    persist?: boolean;
  }): Promise<unknown[][]> {
    const { Session } = await import("../src/harness/session.ts");
    const { runtime } = await import("../src/shared/convex/runtime.ts");
    const mutate = spyOn(runtime, "mutate").mockResolvedValue(null);
    try {
      await new Session({
        eventId: "event",
        conversationKey: "conversation",
        accountId: "acct",
        agentId: "agent",
        agentConfig: {},
        ...options,
      }).saveHarnessSession(state);
      return mutate.mock.calls;
    } finally {
      mutate.mockRestore();
    }
  }

  it("writes the checkpoint under the run's owner fence", async () => {
    expect(await saved({ ownerGeneration: 3 })).toEqual([
      [
        "saveHarnessSession",
        {
          conversationKey: "conversation",
          ownerEventId: "event",
          ownerGeneration: 3,
          ...state,
        },
      ],
    ]);
  });

  it("refuses a persisted checkpoint with no owner instead of writing it unfenced", async () => {
    expect(await saved({}).catch(String)).toContain(
      "Harness checkpoint needs a conversation owner",
    );
  });

  it("keeps nothing for an ephemeral run", async () => {
    expect(await saved({ persist: false })).toEqual([]);
  });
});
