// `local-stack crash`: the recovery sweep hands each conversation's detached result to a resume,
// core is SIGKILLed before the resume's message is saved, and each must be told exactly once.

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import {
  scopedDirectConversationKey,
  scopedDirectEventId,
} from "../../apps/core/src/shared/runtime-keys.ts";
import { pollUntil, type VerifyContext } from "./harness.ts";

const PAYLOAD = "CRASHPAYLOAD-";
const SWEEP_PICKUP_MS = 4 * 60_000;
// The dead run's lease (15 min), a `maintain` pass (5 min) and the sweep after it.
const RECOVERY_WAIT_MS = 25 * 60_000;

export interface CrashOptions {
  adminKey: string;
  convexUrl: string;
  restartCore: () => Promise<void>;
  tracePath: string;
  trials: number;
  waitMs?: number;
}

export interface CrashTrial {
  conversationKey: string;
  handback: string;
  resultId: string;
  told: number;
}

interface Env {
  accountId: string;
  agentId: string;
  context: VerifyContext;
  options: CrashOptions;
}

export async function runCrashRecovery(
  context: VerifyContext,
  options: CrashOptions,
): Promise<CrashTrial[]> {
  const { accountId } = await context.account.getAccount();
  const { agentId } = await context.account.createAgent({
    name: `crash-${context.runId}`,
    config: { ...context.model, agent: { system: "Say OK." } },
  });
  const env: Env = {
    accountId: accountId,
    agentId: agentId,
    context: context,
    options: options,
  };
  const holdOff = `${options.tracePath}.hold-off`;
  rmSync(holdOff, { force: true });
  const ledger = `${options.tracePath}.held`;
  const heldBefore = heldCount(ledger);
  const trials: Array<{ conversationKey: string; resultId: string }> = [];
  // Always restarted: a held write keeps its run, and its worker slot, until core dies.
  try {
    for (let index = 0; index < options.trials; index += 1) {
      const conversationKey = `crash-${context.runId}-${index}`;
      await openConversation(env, conversationKey);
      trials.push({
        conversationKey: conversationKey,
        resultId: await seedDetachedResult(env, conversationKey),
      });
    }
    const held = await pollUntil(
      {
        initialIntervalMs: 500,
        maxIntervalMs: 2_000,
        timeoutMs: SWEEP_PICKUP_MS,
      },
      async (): Promise<true | null> =>
        heldCount(ledger) > heldBefore ? true : null,
    );
    if (!held) throw new Error("the sweep handed no resume to a run");
    // The sweep's pass admits the rest; those wait for a worker and never write.
    await Bun.sleep(5_000);
    console.log(
      `${heldCount(ledger) - heldBefore} resume saves held; killing core`,
    );
  } finally {
    writeFileSync(holdOff, "");
    await options.restartCore();
  }

  return waitUntilTold(env, trials);
}

function heldCount(ledger: string): number {
  return existsSync(ledger)
    ? readFileSync(ledger, "utf8").split("\n").length - 1
    : 0;
}

async function openConversation(
  env: Env,
  conversationKey: string,
): Promise<void> {
  for await (const _part of env.context.client
    .agent("crash", env.agentId)
    .stream({
      conversationKey: conversationKey,
      eventId: `${conversationKey}-t0`,
      input: "Say OK.",
    })) {
    continue;
  }
}

// Created under the conversation's first turn, settled, and left to the recovery sweep.
async function seedDetachedResult(
  env: Env,
  conversationKey: string,
): Promise<string> {
  const resultId = `async_tool_resumehold_${crypto.randomUUID()}`;
  const parent = scopedDirectEventId(
    env.accountId,
    env.agentId,
    `${conversationKey}-t0`,
  );
  await convexAdmin(env, "mutation", "runtime:createAsyncToolResult", {
    resultId: resultId,
    parentEventId: `${parent}:async-bg:${resultId}`,
    conversationKey: scopedKey(env, conversationKey),
    toolName: "bash",
    toolCallId: `seed-${resultId}`,
    input: { command: "crash seed" },
    delivery: { kind: "async" },
  });
  await convexAdmin(env, "mutation", "runtime:updateAsyncToolResult", {
    resultId: resultId,
    status: "completed",
    response: { output: `${PAYLOAD}${resultId}` },
    onlyWhenProcessing: true,
  });
  await convexAdmin(env, "mutation", "runtime:markAsyncToolHandback", {
    resultId: resultId,
    handback: "detached",
  });

  return resultId;
}

async function waitUntilTold(
  env: Env,
  trials: Array<{ conversationKey: string; resultId: string }>,
): Promise<CrashTrial[]> {
  const waitMs = env.options.waitMs ?? RECOVERY_WAIT_MS;
  console.log(
    `core restarted; waiting up to ${waitMs / 60_000} min for recovery`,
  );
  const deadline = Date.now() + waitMs;
  let told = await tell(env, trials);
  while (
    Date.now() < deadline &&
    told.some((trial): boolean => trial.told === 0)
  ) {
    await Bun.sleep(30_000);
    told = await tell(env, trials);
  }
  // A second telling still in flight shows up here.
  await Bun.sleep(5_000);

  return tell(env, trials);
}

async function tell(
  env: Env,
  trials: Array<{ conversationKey: string; resultId: string }>,
): Promise<CrashTrial[]> {
  return Promise.all(
    trials.map(async ({ conversationKey, resultId }): Promise<CrashTrial> => {
      const events = await conversationEvents(
        env,
        scopedKey(env, conversationKey),
      );
      const row = (await convexAdmin(
        env,
        "query",
        "runtime:getAsyncToolResult",
        {
          resultId: resultId,
        },
      )) as { handback?: string } | null;

      return {
        conversationKey: conversationKey,
        handback: row?.handback ?? "missing",
        resultId: resultId,
        told: events.filter((event): boolean =>
          event.includes(`${PAYLOAD}${resultId}`),
        ).length,
      };
    }),
  );
}

async function conversationEvents(
  env: Env,
  conversationKey: string,
): Promise<string[]> {
  const events: string[] = [];
  let afterCursor: string | undefined;
  for (;;) {
    const page = (await convexAdmin(
      env,
      "query",
      "runtime:listConversationEvents",
      {
        conversationKey: conversationKey,
        ...(afterCursor ? { afterCursor: afterCursor } : {}),
      },
    )) as {
      continueCursor: string | null;
      isDone: boolean;
      page: { event: unknown }[];
    };
    events.push(...page.page.map((row): string => JSON.stringify(row.event)));
    if (page.isDone || !page.continueCursor) return events;
    afterCursor = page.continueCursor;
  }
}

function scopedKey(env: Env, conversationKey: string): string {
  return scopedDirectConversationKey(
    env.accountId,
    env.agentId,
    conversationKey,
  );
}

// The admin key may call internal functions.
async function convexAdmin(
  env: Env,
  kind: "query" | "mutation",
  path: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetch(`${env.options.convexUrl}/api/${kind}`, {
    method: "POST",
    headers: {
      authorization: `Convex ${env.options.adminKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ path: path, args: args, format: "json" }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await response.json()) as
    | { status: "success"; value: unknown }
    | { status: "error"; errorMessage: string };
  if (body.status !== "success")
    throw new Error(`${path}: ${body.errorMessage}`);

  return body.value;
}
