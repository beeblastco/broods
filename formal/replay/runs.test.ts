import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { convexTest } from "../../packages/convex/node_modules/convex-test/dist/index.js";
import schema from "../../packages/convex/schema.ts";
import { internal } from "../../packages/convex/_generated/api.js";
import type { Id } from "../../packages/convex/_generated/dataModel.ts";
import {
  rootEventId,
  askingEventId,
  asyncToolContinuationEventId,
} from "../../apps/core/src/harness/async-tool-result.ts";
import {
  isRunnableModelInput,
  turnSettlement,
} from "../../apps/core/src/harness/continuation.ts";
import {
  answersFromChoice,
  answersFromText,
} from "../../apps/core/src/harness/questions.ts";

const originalFetch = globalThis.fetch;
globalThis.fetch = ((): never => {
  throw new Error("Runs replay forbids network");
}) as typeof fetch;
afterAll((): void => {
  globalThis.fetch = originalFetch;
});
const modules: Record<string, () => Promise<unknown>> = {};
for (const path of new Bun.Glob("**/*.ts").scanSync({
  cwd: `${import.meta.dir}/../../packages/convex`,
})) {
  if (!path.startsWith("tests/"))
    modules[`../${path}`] = (): Promise<unknown> =>
      import(`${import.meta.dir}/../../packages/convex/${path}`);
}
interface Input {
  op: string;
  key: number;
  event: number;
  generation: number;
  now: number;
  ttl: number;
  mode: "reject" | "followup" | "collect" | "steer";
  claim: boolean;
  failed: boolean;
}
interface Vector {
  name: string;
  steps: {
    input: Input;
    rows: { key: number; status: string }[];
    generation: number;
  }[];
}
const output = spawnSync(
  `${import.meta.dir}/../.lake/build/bin/spec-replay`,
  ["runs"],
  {
    cwd: `${import.meta.dir}/..`,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${process.env.HOME}/.elan/bin:${process.env.PATH}`,
    },
  },
);
if (output.status !== 0) throw new Error(output.stderr || output.stdout);
const vectors = output.stdout
  .trim()
  .split("\n")
  .map((line): Vector => JSON.parse(line) as Vector);
test.each(vectors.filter((v): boolean => !v.name.startsWith("G1")))(
  "Lean/Convex $name",
  async (vector): Promise<void> => {
    await replay(vector);
  },
);
test.failing.each(vectors.filter((v): boolean => v.name.startsWith("G1")))(
  "G1 D6 $name",
  async (vector): Promise<void> => {
    await replay(vector);
  },
);

async function replay(vector: Vector): Promise<void> {
  const t = convexTest(schema, modules);
  const accountId = await t.run(
    async (ctx): Promise<Id<"accounts">> =>
      await ctx.db.insert("accounts", {
        orgId: "runs-replay",
        username: "runs-replay",
        secretHash: "unused",
        status: "active",
        createdAt: 1,
        updatedAt: 1,
      }),
  );
  const conversationKey = `acct:${accountId}:agent:test:api:replay`;
  const realNow = Date.now;
  try {
    for (const { input: i, rows, generation } of vector.steps) {
      Date.now = (): number => 2000000000000 + i.now;
      const owned = {
        conversationKey: conversationKey,
        ownerEventId: `e${i.event}`,
        ownerGeneration: i.generation,
      };
      switch (i.op) {
        case "accept":
          await t.mutation(internal.runtimeIngress.accept, {
            accountId: accountId,
            agentId: "test",
            conversationKey: conversationKey,
            eventId: `e${i.key}`,
            runId: `run_${i.key}`,
            idempotencyKey: `k${i.key}`,
            payloadDigest: `d${i.key}`,
            events: [{ role: "user", content: "hello" }],
            delivery: {
              kind: "async",
              publicEventId: `e${i.key}`,
              publicConversationKey: conversationKey,
              statusUrl: "https://invalid.test/status",
            },
            requestedMode: i.mode,
            sizeBytes: 1,
            leaseTtlMs: i.ttl,
            envelopeTtlMs: 10 - i.now,
            statusTtlMs: 604800000,
            maxQueuedCount: 100,
            maxQueuedBytes: 1048576,
          });
          break;
        case "takeNext":
          await t.mutation(internal.runtimeIngress.takeNext, {
            ...owned,
            leaseTtlMs: i.ttl,
            settle: { status: "completed" },
          });
          break;
        case "applySteering":
          await t.mutation(internal.runtimeIngress.applySteering, {
            ...owned,
            leaseTtlMs: i.ttl,
          });
          break;
        case "stepBoundary":
          await t.mutation(internal.runtimeIngress.stepBoundary, {
            ...owned,
            leaseTtlMs: i.ttl,
            claimSteering: i.claim,
          });
          break;
        case "renewOwner":
          await t.mutation(internal.runtimeIngress.renewOwner, {
            ...owned,
            leaseTtlMs: i.ttl,
          });
          break;
        case "releaseOwner":
          await t.mutation(internal.runtimeIngress.releaseOwner, owned);
          break;
        case "settle":
          try {
            await t.mutation(internal.runtimeIngress.settle, {
              ...owned,
              status: i.failed ? "failed" : "completed",
            });
          } catch (error) {
            if (
              !(error instanceof Error) ||
              !error.message.includes("Stale conversation owner")
            )
              throw error;
          }
          break;
        case "stopOwner":
          await t.mutation(internal.runtimeIngress.stopOwner, {
            accountId: accountId,
            agentId: "test",
            conversationKey: conversationKey,
          });
          break;
        case "recoverQueued":
          await t.mutation(internal.runtimeIngress.recoverQueued, {
            leaseTtlMs: i.ttl,
          });
          break;
        case "maintain":
          await t.mutation(internal.runtimeIngress.maintain, {});
          break;
        default:
          throw new Error(i.op);
      }
      const actual = await t.run(async (ctx) => {
        const saved = await ctx.db.query("runtimeIngressEnvelopes").collect();
        const coordinator = await ctx.db
          .query("runtimeConversationCoordinators")
          .first();

        return {
          rows: saved
            .sort((a, b): number => a.sequence - b.sequence)
            .map((r) => ({
              key: Number(r.eventId.slice(1)),
              status: r.status,
            })),
          generation: coordinator?.ownerGeneration ?? 0,
        };
      });
      expect(actual).toEqual({ rows: rows, generation: generation });
    }
  } finally {
    Date.now = realNow;
  }
}

test.failing(
  "G3 D8 rejects unrelated terminal async overwrite",
  async (): Promise<void> => {
    const t = convexTest(schema, modules);
    const accountId = await t.run(
      async (ctx) =>
        await ctx.db.insert("accounts", {
          orgId: "async",
          username: "async",
          secretHash: "unused",
          status: "active",
          createdAt: 1,
          updatedAt: 1,
        }),
    );
    await t.mutation(internal.runtime.createAsyncAgentResult, {
      eventId: "finished",
      conversationKey: `acct:${accountId}:agent:test:api:async`,
    });
    await t.mutation(internal.runtime.updateAsyncAgentResult, {
      eventId: "finished",
      status: "completed",
      response: "first",
    });
    await t.mutation(internal.runtime.updateAsyncAgentResult, {
      eventId: "finished",
      status: "failed",
      error: "unrelated",
    });
    expect(
      (
        await t.query(internal.runtime.getAsyncAgentResult, {
          eventId: "finished",
        })
      )?.status,
    ).toBe("completed");
  },
);

test("pure continuation identity and runnable inputs", (): void => {
  expect(rootEventId("run:async-tools:r:async-question:q")).toBe("run");
  expect(rootEventId("async-tools:human")).toBe("async-tools:human");
  const row = { parentEventId: "run:async-question:q", resultId: "q" };
  expect(askingEventId(row)).toBe("run");
  expect(asyncToolContinuationEventId(row)).toBe("run:async-tools:q");
  expect(isRunnableModelInput({ role: "user", content: "hi" })).toBe(true);
  expect(isRunnableModelInput(undefined)).toBe(false);
  expect(isRunnableModelInput({ role: "tool", content: [] })).toBe(false);
  expect(
    turnSettlement({
      didFail: true,
      failureText: null,
      approvals: [],
      questions: [],
    }),
  ).toEqual({ status: "failed", error: "Agent processing failed" });
});
test("question choices and first-question typed answers", (): void => {
  const pending = {
    questions: [
      {
        id: "q",
        question: "Choose",
        options: [{ label: "Yes" }, { label: "No" }],
      },
    ],
    blocking: true,
    answerBy: "2099-01-01",
  };
  expect(
    answersFromChoice(pending, { questionIndex: 0, optionIndex: 1 }),
  ).toEqual({ q: ["No"] });
  expect(
    answersFromChoice(pending, { questionIndex: 1, optionIndex: 0 }),
  ).toBeUndefined();
  expect(answersFromText(pending, " 2 ")?.answers).toEqual({ q: ["No"] });
  expect(answersFromText(pending, "yes")?.answers).toEqual({ q: ["Yes"] });
  expect(answersFromText(pending, "   ")).toBeUndefined();
});

test("G200 retention deletion permits a second run for the same idempotency key", async (): Promise<void> => {
  const realDate = Date;
  let now = 2000000000000;
  globalThis.Date = new Proxy(realDate, {
    get: function (target, property, receiver): unknown {
      return property === "now"
        ? (): number => now
        : Reflect.get(target, property, receiver);
    },
  });
  try {
    const t = convexTest(schema, modules);
    const accountId = await t.run(
      async (ctx) =>
        await ctx.db.insert("accounts", {
          orgId: "retention",
          username: "retention",
          secretHash: "unused",
          status: "active",
          createdAt: now,
          updatedAt: now,
        }),
    );
    const key = `acct:${accountId}:agent:test:api:retention`;
    const candidate = {
      accountId: accountId,
      agentId: "test",
      conversationKey: key,
      eventId: "first",
      runId: "run_first",
      idempotencyKey: "same",
      payloadDigest: "same",
      events: [{ role: "user", content: "hello" }],
      delivery: {
        kind: "async" as const,
        publicEventId: "first",
        publicConversationKey: key,
        statusUrl: "https://invalid.test/status",
      },
      requestedMode: "followup" as const,
      sizeBytes: 1,
      leaseTtlMs: 100,
      envelopeTtlMs: 10,
      statusTtlMs: 20,
      maxQueuedCount: 100,
      maxQueuedBytes: 1048576,
    };
    const first = await t.mutation(internal.runtimeIngress.accept, candidate);
    expect(first.outcome).toBe("owner");
    await t.mutation(internal.runtimeIngress.settle, {
      conversationKey: key,
      ownerEventId: "first",
      ownerGeneration: first.ownerGeneration!,
      status: "completed",
    });
    await t.mutation(internal.runtimeIngress.releaseOwner, {
      conversationKey: key,
      ownerEventId: "first",
      ownerGeneration: first.ownerGeneration!,
    });
    now += 21;
    expect(
      (await t.mutation(internal.runtimeIngress.maintain, {})).deleted,
    ).toBe(1);
    const retry = await t.mutation(internal.runtimeIngress.accept, {
      ...candidate,
      eventId: "second",
      runId: "run_second",
    });
    expect(retry.outcome).toBe("owner");
    expect(retry.runId).toBe("run_second");
  } finally {
    globalThis.Date = realDate;
  }
});
