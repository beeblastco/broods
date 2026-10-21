import type { HarnessAgentSession } from "@ai-sdk/harness/agent";
import { describe, expect, it, jest, mock, spyOn } from "bun:test";
import type { AiSdkHarnessRuntime } from "../src/harness/ai-sdk-harness/runtime.ts";
import {
  harnessReservationKey,
  openAiSdkHarnessSession,
  parkAiSdkHarnessSession,
  prepareHarnessTurn,
  type PrepareHarnessTurnOptions,
} from "../src/harness/ai-sdk-harness/session.ts";
import { sandboxNeighbours } from "../src/harness/sandbox/live-status.ts";
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

describe("prepareHarnessTurn", () => {
  it("stores the input, applies steering, then loads the stored session", async () => {
    const calls: string[] = [];
    const turn = await prepareHarnessTurn(turnOptions({ calls: calls }));
    await turn.dispose();

    expect(calls).toEqual(["flush", "steering", "load", "createAgent"]);
  });

  it("stops its own lease monitor and destroys the session", async () => {
    const destroy = mock(async (): Promise<void> => {});
    const setTimer = spyOn(globalThis, "setInterval");
    const clearTimer = spyOn(globalThis, "clearInterval");
    try {
      const turn = await prepareHarnessTurn(
        turnOptions({
          openSession: async (): Promise<HarnessAgentSession> =>
            ({ destroy: destroy }) as never,
        }),
      );
      const monitor = setTimer.mock.results.at(-1)?.value;
      await turn.dispose();

      expect(destroy).toHaveBeenCalledTimes(1);
      expect(clearTimer).toHaveBeenCalledWith(monitor);
    } finally {
      setTimer.mockRestore();
      clearTimer.mockRestore();
    }
  });

  it("renews the lease while the session is still opening", async () => {
    const calls: string[] = [];
    let callsAtOpen: string[] = [];
    jest.useFakeTimers();
    try {
      const turn = await prepareHarnessTurn(
        turnOptions({
          calls: calls,
          openSession: async (): Promise<HarnessAgentSession> => {
            jest.advanceTimersByTime(1_500);
            callsAtOpen = [...calls];

            return { destroy: async (): Promise<void> => {} } as never;
          },
        }),
      );
      await turn.dispose();

      expect(callsAtOpen).toContain("renew");
    } finally {
      jest.useRealTimers();
    }
  });

  it("holds a stop reported during the open until the session exists", async () => {
    const abortController = new AbortController();
    let abortedDuringOpen = true;
    jest.useFakeTimers();
    try {
      const turn = await prepareHarnessTurn(
        turnOptions({
          abortController: abortController,
          openSession: async (): Promise<HarnessAgentSession> => {
            jest.advanceTimersByTime(1_500);
            await Promise.resolve();
            abortedDuringOpen = abortController.signal.aborted;

            return { destroy: async (): Promise<void> => {} } as never;
          },
          renew: async (): Promise<"stopped"> => "stopped",
        }),
      );
      await turn.dispose();

      expect(abortedDuringOpen).toBe(false);
      expect(abortController.signal.aborted).toBe(true);
      expect(abortController.signal.reason).toHaveProperty(
        "message",
        "stopped",
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it("ignores a renewal that settles after the monitor stopped", async () => {
    const abortController = new AbortController();
    let settle: (renewal: "stale") => void = (): void => {};
    jest.useFakeTimers();
    try {
      const turn = await prepareHarnessTurn(
        turnOptions({
          abortController: abortController,
          renew: (): Promise<"stale"> =>
            new Promise((resolve): void => {
              settle = resolve;
            }),
        }),
      );
      jest.advanceTimersByTime(1_500);
      turn.stopLeaseMonitor();
      settle("stale");
      await Promise.resolve();
      await Promise.resolve();
      await turn.dispose();

      expect(abortController.signal.aborted).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it("stops the lease monitor and leaves the occupancy release to the caller when the session fails to open", async () => {
    const setTimer = spyOn(globalThis, "setInterval");
    const clearTimer = spyOn(globalThis, "clearInterval");
    let release: (() => void) | undefined;
    try {
      const failed = prepareHarnessTurn(
        turnOptions({
          onOccupied: (handed): void => {
            release = handed;
          },
          openSession: async (): Promise<never> => {
            throw new Error("machine down");
          },
        }),
      );

      expect(failed).rejects.toThrow("machine down");
      await failed.catch((): void => {});
      const monitor = setTimer.mock.results.at(-1)?.value;
      expect(monitor).toBeDefined();
      expect(clearTimer).toHaveBeenCalledWith(monitor);
      expect(sandboxNeighbours("machine-key", "other-event")).toHaveLength(1);
      release?.();
      expect(sandboxNeighbours("machine-key", "other-event")).toEqual([]);
    } finally {
      setTimer.mockRestore();
      clearTimer.mockRestore();
      release?.();
    }
  });

  function turnOptions(
    overrides: Partial<PrepareHarnessTurnOptions> & {
      calls?: string[];
      renew?: () => Promise<"renewed" | "stopped" | "stale">;
    },
  ): PrepareHarnessTurnOptions {
    const {
      calls = [],
      renew = async (): Promise<"renewed"> => "renewed",
      ...options
    } = overrides;

    return {
      abortController: new AbortController(),
      agentConfig: { harness: { type: "codex" } } as never,
      agentReservationKey: undefined,
      applySteering: async (): Promise<void> => {
        calls.push("steering");
      },
      configuredApprovals: new Map(),
      createAgent: (): AiSdkHarnessRuntime => {
        calls.push("createAgent");

        return { agent: {}, reservationKey: "machine-key" } as never;
      },
      isolated: false,
      metadata: { traceId: "trace", taskId: "event" },
      onOccupied: (release): void => release(),
      openSession: async (): Promise<HarnessAgentSession> =>
        ({ destroy: async (): Promise<void> => {} }) as never,
      sandbox: { name: "default", sandbox: { provider: "lambda" } } as never,
      session: {
        agentId: "agent",
        conversationKey: "conversation",
        eventId: "event",
        environmentText: (): string => "<environment>",
        flushPendingStoredEvents: async (): Promise<void> => {
          calls.push("flush");
        },
        loadHarnessSession: async (): Promise<null> => {
          calls.push("load");

          return null;
        },
        loadHarnessSkills: async (): Promise<never[]> => [],
        renewConversationLease: (): Promise<
          "renewed" | "stopped" | "stale"
        > => {
          calls.push("renew");

          return renew();
        },
      } as never,
      stopMessage: "stopped",
      tools: {},
      turnContext: { system: [] } as never,
      ...options,
    };
  }
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
