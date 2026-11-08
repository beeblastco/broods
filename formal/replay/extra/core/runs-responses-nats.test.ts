import { afterEach, describe, expect, mock, test } from "bun:test";

import {
  asyncAdmissionResponse,
  directAdmissionResponse,
  emptySseResponse,
  natsStartResponse,
} from "../../../../apps/core/src/harness/responses.ts";
import { waitUntilMs } from "../../../../apps/core/src/harness/continuation.ts";
import type { NatsConnection } from "../../../../apps/core/src/shared/nats.ts";

type DirectEvent = Parameters<typeof directAdmissionResponse>[0];
type AsyncEvent = Parameters<typeof asyncAdmissionResponse>[0];
type Admission = Parameters<typeof directAdmissionResponse>[1];
type StartEvent = Parameters<typeof natsStartResponse>[0];
type Context = Parameters<typeof waitUntilMs>[0];

const PUBLIC_URL_ENV = "PUBLIC_BASE_URL";
const mutate = mock(async (): Promise<unknown> => null);
const RUNTIME_PATH = import.meta
  .resolve("../../../../apps/core/src/shared/convex/runtime.ts");
const realRuntime = await import(RUNTIME_PATH);

await mock.module(RUNTIME_PATH, () => ({
  ...realRuntime,
  runtime: { query: mock(async (): Promise<unknown> => []), mutate: mutate },
}));

// Lazy so the runtime mock above is in place first.
const {
  conversationLastSequence,
  logsSubject,
  retainedMessageSubject,
  tracesSubject,
} = await import("../../../../apps/core/src/shared/nats.ts");
const {
  bindAsyncToolResultSandbox,
  markAsyncToolHandback,
  markAsyncToolResultCompleted,
} = await import("../../../../apps/core/src/harness/async-tool-result.ts");
const { applySteering } =
  await import("../../../../apps/core/src/harness/ingress.ts");

const baseEvent = {
  accountId: "acct_1",
  agentId: "agent_1",
  runId: "run_1",
  publicEventId: "event-public",
  publicConversationKey: "conv-public",
  requestedMode: "steer",
  statusUrl: "https://fallback.test/v1/runs/run_1",
};

function connectionWith(getMessage: () => Promise<unknown>): NatsConnection {
  return {
    jetstreamManager: async (): Promise<object> => ({
      streams: { getMessage: getMessage },
    }),
  } as unknown as NatsConnection;
}

afterEach((): void => {
  delete process.env[PUBLIC_URL_ENV];
  mutate.mockReset();
  mutate.mockImplementation(async (): Promise<unknown> => null);
});

describe("subjects", () => {
  test.each([
    ["dev", "v1.a.p.ZGV2.logs.e", "v1.a.p.ZGV2.traces.e"],
    ["pr.12", "logs", "traces"],
  ])("stage %s stays inside one subject token", (stage, logs, traces): void => {
    const logsValue = logsSubject("a", "p", stage, "e");
    const tracesValue = tracesSubject("a", "p", stage, "e");
    expect(logsValue).toContain(logs);
    expect(tracesValue).toContain(traces);
    expect(logsValue.split(".")).toHaveLength(6);
  });
});

describe("stream reads", () => {
  test.each([
    [
      "found",
      async (): Promise<unknown> => ({ seq: 7, subject: "s.7" }),
      7,
      "s.7",
    ],
    [
      "gone",
      async (): Promise<unknown> => {
        throw new Error("no message");
      },
      null,
      null,
    ],
  ])("%s", async (_name, getMessage, sequence, subject): Promise<void> => {
    const connection = connectionWith(getMessage);
    const last = await conversationLastSequence({
      connection: connection,
      accountId: "a",
      agentId: "b",
      conversationKey: "c",
    });
    expect(last).toBe(sequence);
    expect(await retainedMessageSubject(connection, 7)).toBe(subject);
  });
});

describe("waitUntilMs", () => {
  test.each([
    ["no context", undefined],
    ["infinite deadline", { deadlineMs: Number.POSITIVE_INFINITY }],
    ["zero deadline", { deadlineMs: 0 }],
    ["far deadline", { deadlineMs: Date.now() + 3_600_000 }],
    ["passed deadline", { deadlineMs: 1 }],
  ])("%s lands in the future or now", (_name, context): void => {
    const before = Date.now();
    expect(waitUntilMs(context as unknown as Context)).toBeGreaterThanOrEqual(
      before,
    );
  });
});

describe("admission responses", () => {
  test.each([
    ["rejected", 409],
    ["capacity", 429],
    ["conflict", 409],
    ["queued", 202],
    ["owner", 202],
  ])(
    "%s answers %i in every format",
    async (outcome, status): Promise<void> => {
      const admission = {
        outcome: outcome,
        eventId: "acct:acct_1:agent:agent_1:api:e1",
      } as Admission;
      const event = baseEvent as unknown as DirectEvent;
      expect(directAdmissionResponse(event, admission, true).status).toBe(
        status,
      );
      expect(directAdmissionResponse(event, admission, false).status).toBe(
        status,
      );
      expect(
        asyncAdmissionResponse(baseEvent as unknown as AsyncEvent, admission)
          .status,
      ).toBe(status);
    },
  );

  test("a duplicate names the first run, and a public URL wins over the event's", async (): Promise<void> => {
    process.env[PUBLIC_URL_ENV] = "https://core.test";
    const admission = {
      outcome: "duplicate",
      runId: "run_first",
      status: "completed",
    } as Admission;
    const direct = await directAdmissionResponse(
      baseEvent as unknown as DirectEvent,
      admission,
      true,
    ).json();
    expect(direct).toMatchObject({
      runId: "run_first",
      status: "completed",
      statusUrl: "https://core.test/v1/runs/run_first",
    });
    const queued = await asyncAdmissionResponse(
      baseEvent as unknown as AsyncEvent,
      admission,
    ).json();
    expect(queued).toMatchObject({
      statusUrl: "https://core.test/v1/runs/run_first",
    });
  });

  test.each([
    ["with url", "https://core.test/v1/runs/run_1", true],
    ["without url", null, false],
  ])("nats start %s", async (_name, statusUrl, present): Promise<void> => {
    const body = await natsStartResponse(
      baseEvent as unknown as StartEvent,
      "event-public",
      statusUrl,
    ).json();
    expect(body).toMatchObject({
      eventId: "event-public",
      status: "processing",
    });
    expect("statusUrl" in (body as object)).toBe(present);
  });

  test("an empty event stream closes with no frames", async (): Promise<void> => {
    expect(await emptySseResponse().text()).toBe("");
  });
});

describe("async tool rows", () => {
  test("a hand-back failure is logged, not raised", async (): Promise<void> => {
    mutate.mockImplementation(async (): Promise<unknown> => {
      throw new Error("down");
    });
    const handback = "detached" as Parameters<typeof markAsyncToolHandback>[1];
    await expect(
      markAsyncToolHandback("r1", handback),
    ).resolves.toBeUndefined();
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  test("a hand-back and a completion write their row", async (): Promise<void> => {
    const handback = "detached" as Parameters<typeof markAsyncToolHandback>[1];
    await markAsyncToolHandback("r1", handback);
    await markAsyncToolResultCompleted({ resultId: "r1", response: "done" });
    expect(mutate).toHaveBeenCalledTimes(2);
  });

  test("binding a sandbox names the result", async (): Promise<void> => {
    const sandbox = { id: "sb" } as unknown as Parameters<
      typeof bindAsyncToolResultSandbox
    >[1];
    await bindAsyncToolResultSandbox("r1", sandbox);
    expect(mutate).toHaveBeenCalledTimes(1);
  });
});

describe("applySteering", () => {
  test.each([[true], [false], [undefined]])(
    "textOnly %s",
    async (textOnly): Promise<void> => {
      await applySteering({
        conversationKey: "c",
        ownerEventId: "e",
        ownerGeneration: 1,
        ...(textOnly === undefined ? {} : { textOnly: textOnly }),
      });
      expect(mutate).toHaveBeenCalledTimes(1);
    },
  );
});
