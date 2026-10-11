/**
 * What the outbox does when core does not take an event. Each case runs
 * `fixtures/delivery.ts` in its own process; that file says why, and its
 * `SCRIPTS` say what each webhook answers.
 *
 * The sync token on disk never waits on a delivery, the outbox does: a run
 * ends at `s3`, the last sync the homeserver serves, or at `s2` when the
 * account is stopped while it delivers the sync that served the messages.
 */

import { describe, expect, it } from "bun:test";
import { join } from "node:path";

interface DeliveryRun {
  /** What each webhook path answered, in order. */
  deliveries: Record<string, Array<number | "hang">>;
  /** Rows left in the outbox. */
  held: number;
  /** The event id of every POST, in order. */
  posted: string[];
  /** The `Matrix event dropped from the outbox` log lines. */
  dropped: Array<Record<string, unknown>>;
  token: string;
}

describe("a message core does not take", () => {
  it("is retried until it lands", async () => {
    expect(await run("transient")).toEqual({
      deliveries: { a: [503, 200] },
      dropped: [],
      held: 0,
      posted: ["$customer-0", "$customer-0"],
      token: "s3",
    });
  });

  it("treats a 429 like a 5xx", async () => {
    expect(await run("ratelimited")).toEqual({
      deliveries: { a: [429, 200] },
      dropped: [],
      held: 0,
      posted: ["$customer-0", "$customer-0"],
      token: "s3",
    });
  });

  it("is settled by a 4xx, which answers the same every time", async () => {
    expect(await run("rejected")).toEqual({
      deliveries: { a: [404] },
      dropped: [],
      held: 0,
      posted: ["$customer-0"],
      token: "s3",
    });
  });

  // #1033: core down past the old 5 minute window, and the forwarder
  // restarting meanwhile, used to lose the message.
  it("survives an outage longer than five minutes and a restart", async () => {
    expect(await run("outage")).toEqual({
      deliveries: { a: [503, 503, 200] },
      dropped: [],
      held: 0,
      posted: ["$customer-0", "$customer-0", "$customer-0"],
      token: "s3",
    });
  });

  it("survives a webhook timeout and a restart", async () => {
    expect(await run("timeout")).toEqual({
      deliveries: { a: ["hang", 200] },
      dropped: [],
      held: 0,
      posted: ["$customer-0", "$customer-0"],
      token: "s3",
    });
  }, 30_000);

  // An agent's webhook path can move while an event waits for it.
  it("follows its agent to a new webhook path", async () => {
    expect(await run("moved")).toEqual({
      deliveries: { a: [503], moved: [200] },
      dropped: [],
      held: 0,
      posted: ["$customer-0", "$customer-0"],
      token: "s3",
    });
  });

  it("holds the later messages of its room while it waits for its room key", async () => {
    expect(await run("locked")).toEqual({
      deliveries: { a: [200, 200] },
      dropped: [],
      held: 0,
      posted: ["$customer-0", "$customer-1"],
      token: "s3",
    });
  });

  it("is posted again only to the target that did not take it", async () => {
    expect(await run("healthy")).toEqual({
      deliveries: { a: [200], b: [503, 200] },
      dropped: [],
      held: 0,
      posted: ["$customer-0", "$customer-0", "$customer-0"],
      token: "s3",
    });
  });
});

describe("the outbox bounds", () => {
  it("drops an event past its 12 hour TTL, with a log line", async () => {
    expect(await run("expired")).toEqual({
      deliveries: { a: [503] },
      dropped: [
        {
          agentIds: "agent-a",
          attempts: 1,
          eventId: "$customer-0",
          reason: "expired",
        },
      ],
      held: 0,
      posted: ["$customer-0"],
      token: "s3",
    });
  });

  it("drops the oldest event past 5,000 rows", async () => {
    expect(await run("overflow")).toEqual({
      deliveries: { a: [503] },
      dropped: [
        {
          agentIds: "agent-a",
          attempts: 0,
          eventId: "$customer-0",
          reason: "overflow",
        },
      ],
      held: 5_000,
      posted: ["$customer-1"],
      token: "s2",
    });
  });

  it("drops the oldest event past 50 MB", async () => {
    expect(await run("bytes")).toEqual({
      deliveries: { a: [503] },
      dropped: [
        {
          agentIds: "agent-a",
          attempts: 0,
          eventId: "$customer-0",
          reason: "overflow",
        },
      ],
      held: 1,
      posted: ["$customer-1"],
      token: "s2",
    });
  });
});

async function run(mode: string): Promise<DeliveryRun> {
  const child = Bun.spawn(
    [process.execPath, join(import.meta.dir, "fixtures/delivery.ts"), mode],
    { stderr: "pipe", stdout: "pipe" },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
  // The account's own log lines share stdout.
  const lines = stdout.split("\n").filter(Boolean);
  const result: Omit<DeliveryRun, "dropped"> = JSON.parse(
    lines.find((line): boolean => line.startsWith('{"deliveries"')) ?? "null",
  );
  const dropped = lines
    .map((line): Record<string, unknown> => JSON.parse(line))
    .filter(
      (line): boolean =>
        line.message === "Matrix event dropped from the outbox",
    )
    .map(
      ({ agentIds, attempts, eventId, reason }): Record<string, unknown> => ({
        agentIds: agentIds,
        attempts: attempts,
        eventId: eventId,
        reason: reason,
      }),
    );

  return { ...result, dropped: dropped };
}
