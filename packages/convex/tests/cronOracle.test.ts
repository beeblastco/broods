// @vitest-environment node
/// <reference types="vite/client" />
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import cronsComponent from "@convex-dev/crons/test";
import { convexTest } from "convex-test";
import fc from "fast-check";
import { expect, test } from "vitest";
import {
  oracleRuns,
  oracleSeed,
} from "../../../verification/tests/oracle-options";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");

const ORACLE = new URL(
  "../../../verification/.lake/build/bin/cron-oracle",
  import.meta.url,
).pathname;

// Fire times are small model numbers; the mutations see them as ms after this.
const EPOCH_MS = 1_000_000;

// One write the generator picks; `pick` chooses which started run a settle names.
type Op =
  | { kind: "start"; t: number }
  | { kind: "complete" | "fail"; pick: number }
  | { kind: "refuse"; t: number };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ kind: fc.constant("start" as const), t: fc.nat({ max: 4 }) }),
  fc.record({
    kind: fc.constantFrom("complete" as const, "fail" as const),
    pick: fc.nat(),
  }),
  fc.record({ kind: fc.constant("refuse" as const), t: fc.nat({ max: 4 }) }),
);

test("the cron mutations agree with the Lean model's run on generated write orders", async (): Promise<void> => {
  if (!existsSync(ORACLE)) {
    throw new Error(
      `missing ${ORACLE}: run \`lake build cron-oracle\` in verification/`,
    );
  }
  // Each case runs real mutations, so it takes a tenth of the pure oracles' runs.
  const cases = fc
    .sample(fc.array(opArb, { maxLength: 8 }), {
      seed: oracleSeed(),
      numRuns: Math.ceil(oracleRuns() / 10),
    })
    .map(modelSteps);
  const oracle = spawnSync(ORACLE, {
    input: cases.map((steps) => `${steps.join(" ")}\n`).join(""),
    encoding: "utf8",
  });
  expect(oracle.status).toBe(0);
  const answers = oracle.stdout.split("\n").slice(0, -1);
  expect(answers).toHaveLength(cases.length);

  const tt = convexTest(schema, modules);
  cronsComponent.register(tt);
  const { accountId, agentId } = await seedAgent(tt);
  const disagreements: Array<{ steps: string; ts: string; lean: string }> = [];
  for (const [index, steps] of cases.entries()) {
    const ts = await runSteps(tt, accountId, agentId, steps);
    const lean = answers[index] ?? "";
    if (ts !== lean) {
      disagreements.push({ steps: steps.join(" "), ts: ts, lean: lean });
    }
  }
  disagreements.sort((a, b) => a.steps.length - b.steps.length);
  expect(disagreements.slice(0, 5)).toEqual([]);
}, 120_000);

// `start:r:t`, `complete:r`, `fail:r`, `refuse:t`, as `CronOracle.lean` reads them: every
// start opens a fresh run, and a settle names a run already started.
function modelSteps(ops: Op[]): string[] {
  let started = 0;

  return ops.flatMap((op): string[] => {
    if (op.kind === "start") {
      started += 1;

      return [`start:${started - 1}:${op.t}`];
    }
    if (op.kind === "refuse") return [`refuse:${op.t}`];
    if (started === 0) return [];

    return [`${op.kind}:${op.pick % started}`];
  });
}

// Runs `steps` against a new cron row, then prints its runs and cron the way the oracle does.
async function runSteps(
  tt: ReturnType<typeof convexTest>,
  accountId: Id<"accounts">,
  agentId: Id<"agents">,
  steps: string[],
): Promise<string> {
  const cronId = await tt.run(
    async (ctx): Promise<Id<"crons">> =>
      await ctx.db.insert("crons", {
        accountId: accountId,
        name: `oracle-${crypto.randomUUID()}`,
        agentId: agentId,
        events: [],
        scheduleExpression: "rate(1 day)",
        status: "active" as const,
        createdAt: EPOCH_MS,
        updatedAt: EPOCH_MS,
      }),
  );
  const runs: Id<"cronRuns">[] = [];
  for (const step of steps) {
    const [kind = "", first = "0", second = "0"] = step.split(":");
    const ids = { accountId: accountId, cronId: cronId };
    if (kind === "start") {
      runs.push(
        await tt.mutation(internal.agent.crons.createRun, {
          ...ids,
          eventId: `oracle-${runs.length}`,
          conversationKey: "api:cron",
          firedAt: EPOCH_MS + Number(second),
        }),
      );
    } else if (kind === "refuse") {
      await tt.mutation(internal.agent.crons.recordFailedFire, {
        ...ids,
        error: "refused",
        firedAt: EPOCH_MS + Number(first),
      });
    } else {
      const runId = runs[Number(first)];
      if (runId === undefined) throw new Error(`no run ${first}`);
      await (kind === "complete"
        ? tt.mutation(internal.agent.crons.completeRun, {
            ...ids,
            runId: runId,
            result: "done",
          })
        : tt.mutation(internal.agent.crons.failRun, {
            ...ids,
            runId: runId,
            error: "failed",
          }));
    }
  }

  return await tt.run(async (ctx): Promise<string> => {
    const rows = await Promise.all(
      (runs.length === 0 ? [undefined] : runs).map(
        async (runId, index): Promise<string> => {
          const row = runId === undefined ? null : await ctx.db.get(runId);

          return `${index}=${row?.status ?? "-"}`;
        },
      ),
    );
    const cron = await ctx.db.get(cronId);
    const lastRun =
      cron?.lastRunId === undefined ? "-" : runs.indexOf(cron.lastRunId);
    const lastFired =
      cron?.lastInvokedAt === undefined ? "-" : cron.lastInvokedAt - EPOCH_MS;

    return `${rows.join(" ")} cron=${lastRun},${cron?.lastStatus ?? "-"},${lastFired}`;
  });
}

// An account and an agent every generated cron hangs off.
async function seedAgent(
  tt: ReturnType<typeof convexTest>,
): Promise<{ accountId: Id<"accounts">; agentId: Id<"agents"> }> {
  return await tt.run(async (ctx) => {
    const accountId = await ctx.db.insert("accounts", {
      orgId: "org-placeholder",
      username: "cron-oracle",
      secretHash: "hash",
      status: "active" as const,
      createdAt: EPOCH_MS,
      updatedAt: EPOCH_MS,
    });
    const agentId = await ctx.db.insert("agents", {
      accountId: accountId,
      name: "agent",
      createdAt: EPOCH_MS,
      updatedAt: EPOCH_MS,
    });

    return { accountId: accountId, agentId: agentId };
  });
}
