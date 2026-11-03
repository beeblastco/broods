import { describe, expect, it, jest, mock, spyOn } from "bun:test";
import type { AiSdkHarnessRuntime } from "../src/harness/ai-sdk-harness/runtime.ts";
import {
  harnessReservationKey,
  openAiSdkHarnessSession,
  parkAiSdkHarnessSession,
  prepareHarnessTurn,
  type OpenedHarnessSession,
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
  it("resumes the native session from the Broods checkpoint on the resumed machine", async () => {
    const machine = { stop: mock(async (): Promise<void> => {}) };
    const createSession = mock(async () => ({ sessionId: "native-session" }));
    const resumeSandbox = mock(async () => machine);
    const abortController = new AbortController();

    const opened = await openAiSdkHarnessSession({
      abortSignal: abortController.signal,
      agent: { createSession: createSession } as never,
      sandbox: { resumeSession: resumeSandbox } as never,
      stored: {
        harnessType: "codex",
        sessionId: "native-session",
        resumeState: CHECKPOINT,
      },
      type: "codex",
    });

    expect(resumeSandbox).toHaveBeenCalledWith({
      sessionId: "native-session",
      abortSignal: abortController.signal,
    });
    expect(createSession).toHaveBeenCalledWith({
      sessionId: "native-session",
      resumeFrom: CHECKPOINT,
      sandboxSession: machine,
      abortSignal: abortController.signal,
    });
    expect(opened.sandboxSession).toBe(machine as never);
    expect(machine.stop).not.toHaveBeenCalled();
  });

  it("starts fresh on a new machine when the stored session's machine was released", async () => {
    const fresh = { id: "fresh-machine" };
    const createSession = mock(async () => ({ sessionId: "fresh" }));
    const createSandbox = mock(async () => fresh);

    const opened = await openAiSdkHarnessSession({
      abortSignal: new AbortController().signal,
      agent: { createSession: createSession } as never,
      sandbox: {
        createSession: createSandbox,
        resumeSession: async (): Promise<never> => {
          throw new SandboxGoneError("no reserved workdir sandbox");
        },
      } as never,
      stored: {
        harnessType: "codex",
        sessionId: "native-session",
        resumeState: CHECKPOINT,
      },
      type: "codex",
    });

    expect(opened.nativeSession).toMatchObject({ sessionId: "fresh" });
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(createSession).not.toHaveBeenCalledWith(
      expect.objectContaining({ resumeFrom: CHECKPOINT }),
    );
    expect(createSandbox).toHaveBeenCalledTimes(1);
  });

  it("stops the machine it opened when the native session fails to start", async () => {
    const machine = { stop: mock(async (): Promise<void> => {}) };

    expect(
      openAiSdkHarnessSession({
        abortSignal: new AbortController().signal,
        agent: {
          createSession: async (): Promise<never> => {
            throw new Error("bootstrap failed");
          },
        } as never,
        sandbox: { createSession: async () => machine } as never,
        stored: null,
        type: "codex",
      }),
    ).rejects.toThrow("bootstrap failed");
    await Promise.resolve();
    expect(machine.stop).toHaveBeenCalledTimes(1);
  });

  it("refuses to bind a conversation to another adapter", async () => {
    const createSession = mock(async () => ({ sessionId: "unused" }));
    await expect(
      openAiSdkHarnessSession({
        abortSignal: new AbortController().signal,
        agent: { createSession: createSession } as never,
        sandbox: {} as never,
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

  it("stops its own lease monitor and destroys the session and its machine", async () => {
    const destroy = mock(async (): Promise<void> => {});
    const destroyMachine = mock(async (): Promise<void> => {});
    const setTimer = spyOn(globalThis, "setInterval");
    const clearTimer = spyOn(globalThis, "clearInterval");
    try {
      const turn = await prepareHarnessTurn(
        turnOptions({
          openSession: async (): Promise<OpenedHarnessSession> =>
            ({
              nativeSession: { destroy: destroy },
              sandboxSession: { destroy: destroyMachine },
            }) as never,
        }),
      );
      const monitor = setTimer.mock.results.at(-1)?.value;
      await turn.dispose();

      expect(destroy).toHaveBeenCalledTimes(1);
      expect(destroyMachine).toHaveBeenCalledTimes(1);
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
          openSession: async (): Promise<OpenedHarnessSession> => {
            jest.advanceTimersByTime(1_500);
            callsAtOpen = [...calls];

            return openedSession();
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
          openSession: async (): Promise<OpenedHarnessSession> => {
            jest.advanceTimersByTime(1_500);
            await Promise.resolve();
            abortedDuringOpen = abortController.signal.aborted;

            return openedSession();
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

      await expect(failed).rejects.toThrow("machine down");
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
      openSession: async (): Promise<OpenedHarnessSession> => openedSession(),
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

function openedSession(): OpenedHarnessSession {
  const destroy = async (): Promise<void> => {};

  return {
    nativeSession: { destroy: destroy },
    sandboxSession: { destroy: destroy },
  } as never;
}

describe("parkAiSdkHarnessSession", () => {
  function parked(overrides: {
    detach?: () => Promise<unknown>;
    save?: () => Promise<void>;
    stop?: () => Promise<unknown>;
  }) {
    const native = {
      sessionId: "native-session",
      destroy: mock(async (): Promise<void> => {}),
      detach: mock(overrides.detach ?? (async () => CHECKPOINT)),
      stop: mock(overrides.stop ?? (async () => CHECKPOINT)),
    };
    const machine = {
      destroy: mock(async (): Promise<void> => {}),
      stop: mock(async (): Promise<void> => {}),
    };
    const save = mock(overrides.save ?? (async (): Promise<void> => {}));

    return {
      native: native,
      machine: machine,
      save: save,
      park: (successful: boolean, type: "codex" | "deepagents") =>
        parkAiSdkHarnessSession({
          broodsSession: { saveHarnessSession: save } as never,
          nativeSession: native as never,
          sandboxSession: machine as never,
          reservationKey: "acct:a:agent:b:sandbox",
          successful: successful,
          type: type,
        }),
    };
  }

  it("detaches successful Deep Agents sessions before saving and leaves the machine running", async () => {
    const { native, machine, save, park } = parked({});
    await park(true, "deepagents");

    expect(native.detach).toHaveBeenCalledTimes(1);
    expect(native.stop).not.toHaveBeenCalled();
    expect(machine.stop).not.toHaveBeenCalled();
    expect(machine.destroy).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledWith({
      harnessType: "deepagents",
      sessionId: "native-session",
      resumeState: CHECKPOINT,
      reservationKey: "acct:a:agent:b:sandbox",
    });
  });

  it("stops snapshot-backed adapters and their machine after successful turns", async () => {
    const { native, machine, park } = parked({});
    await park(true, "codex");

    expect(native.detach).not.toHaveBeenCalled();
    expect(native.stop).toHaveBeenCalledTimes(1);
    expect(machine.stop).toHaveBeenCalledTimes(1);
    expect(machine.destroy).not.toHaveBeenCalled();
  });

  it("stops failed sessions instead of leaving live compute", async () => {
    const { native, machine, park } = parked({});
    await park(false, "deepagents");

    expect(native.detach).not.toHaveBeenCalled();
    expect(native.stop).toHaveBeenCalledTimes(1);
    expect(machine.stop).toHaveBeenCalledTimes(1);
  });

  it("stops the machine even when the native stop fails", async () => {
    const { machine, save, park } = parked({
      stop: async (): Promise<never> => {
        throw new Error("stop failed");
      },
    });

    expect(park(true, "codex")).rejects.toThrow("stop failed");
    await Bun.sleep(0);
    expect(machine.stop).toHaveBeenCalledTimes(1);
    expect(machine.destroy).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("destroys the session and its machine when the detach fails", async () => {
    const { native, machine, park } = parked({
      detach: async (): Promise<never> => {
        throw new Error("detach failed");
      },
    });

    expect(park(true, "deepagents")).rejects.toThrow("detach failed");
    await Bun.sleep(0);
    expect(native.destroy).toHaveBeenCalledTimes(1);
    expect(machine.destroy).toHaveBeenCalledTimes(1);
  });

  it("keeps a parked machine when the owner-fenced save is refused", async () => {
    const { native, machine, park } = parked({
      save: async (): Promise<never> => {
        throw new Error("stale owner");
      },
    });

    expect(park(true, "deepagents")).rejects.toThrow("stale owner");
    await Bun.sleep(0);
    expect(native.destroy).not.toHaveBeenCalled();
    expect(machine.destroy).not.toHaveBeenCalled();
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
          entries: [],
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
