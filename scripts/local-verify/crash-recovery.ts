// `local-stack crash`: the recovery sweep hands each conversation's detached result to a resume,
// core is SIGKILLed before the resume's message is saved, and each must be told exactly once.

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import {
  scopedDirectConversationKey,
  scopedDirectEventId,
} from "../../apps/core/src/shared/runtime-keys.ts";
import { convexResult, pollUntil, type VerifyContext } from "./harness.ts";

const PAYLOAD = "CRASHPAYLOAD-";
// The dead run's lease (15 min), a `maintain` pass (5 min) and the sweep after it.
const RECOVERY_WAIT_MS = 25 * 60_000;

export interface CrashOptions {
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

export async function runCrashRecovery(
  context: VerifyContext,
  options: CrashOptions,
): Promise<CrashTrial[]> {
  const { accountId } = await context.account.getAccount();
  const { agentId } = await context.account.createAgent({
    name: `crash-${context.runId}`,
    config: { ...context.model, agent: { system: "Say OK." } },
  });
  const holdOff = `${options.tracePath}.hold-off`;
  const ledger = `${options.tracePath}.held`;
  const held = (): number =>
    existsSync(ledger)
      ? readFileSync(ledger, "utf8").split("\n").length - 1
      : 0;
  rmSync(holdOff, { force: true });
  const heldBefore = held();
  const trials: CrashTrial[] = [];
  // Always restarted: a held write keeps its run, and its worker slot, until core dies.
  try {
    for (let index = 0; index < options.trials; index += 1) {
      const publicKey = `crash-${context.runId}-${index}`;
      for await (const _part of context.client.agent("crash", agentId).stream({
        conversationKey: publicKey,
        eventId: `${publicKey}-t0`,
        input: "Say OK.",
      })) {
        continue;
      }
      const conversationKey = scopedDirectConversationKey(
        accountId,
        agentId,
        publicKey,
      );
      const parent = scopedDirectEventId(accountId, agentId, `${publicKey}-t0`);
      trials.push({
        conversationKey: conversationKey,
        handback: "detached",
        resultId: seedDetachedResult(context, conversationKey, parent),
        told: 0,
      });
    }
    const picked = await pollUntil(
      { initialIntervalMs: 500, maxIntervalMs: 2_000, timeoutMs: 4 * 60_000 },
      async (): Promise<true | null> => (held() > heldBefore ? true : null),
    );
    if (!picked) throw new Error("the sweep handed no resume to a run");
    // The sweep's pass admits the rest; those wait for a worker and never write.
    await Bun.sleep(5_000);
    console.log(`${held() - heldBefore} resume saves held; killing core`);
  } finally {
    writeFileSync(holdOff, "");
    await options.restartCore();
  }

  const deadline = Date.now() + (options.waitMs ?? RECOVERY_WAIT_MS);
  console.log(
    `core restarted; waiting until ${new Date(deadline).toISOString()}`,
  );
  while (
    Date.now() < deadline &&
    tell(context, trials).some((trial) => trial.told === 0)
  ) {
    await Bun.sleep(30_000);
  }
  // A second telling still in flight shows up here.
  await Bun.sleep(5_000);

  return tell(context, trials);
}

// Created under the conversation's first turn, settled, and left to the recovery sweep.
function seedDetachedResult(
  context: VerifyContext,
  conversationKey: string,
  parentEventId: string,
): string {
  const resultId = `async_tool_resumehold_${crypto.randomUUID()}`;
  convexResult(
    context,
    "runtime:createAsyncToolResult",
    {
      resultId: resultId,
      parentEventId: `${parentEventId}:async-bg:${resultId}`,
      conversationKey: conversationKey,
      toolName: "bash",
      toolCallId: `seed-${resultId}`,
      input: { command: "crash seed" },
      delivery: { kind: "async" },
    },
    "seed a background result",
  );
  convexResult(
    context,
    "runtime:updateAsyncToolResult",
    {
      resultId: resultId,
      status: "completed",
      response: { output: `${PAYLOAD}${resultId}` },
      onlyWhenProcessing: true,
    },
    "settle the result",
  );
  convexResult(
    context,
    "runtime:markAsyncToolHandback",
    { resultId: resultId, handback: "detached" },
    "hand the result to the recovery sweep",
  );

  return resultId;
}

function tell(context: VerifyContext, trials: CrashTrial[]): CrashTrial[] {
  return trials.map((trial): CrashTrial => {
    const history = convexResult<{ page: { event: unknown }[] }>(
      context,
      "runtime:listConversationEvents",
      { conversationKey: trial.conversationKey },
      "read the conversation",
    );
    const row = convexResult<{ handback?: string } | null>(
      context,
      "runtime:getAsyncToolResult",
      { resultId: trial.resultId },
      "read the result row",
    );

    return {
      ...trial,
      handback: row?.handback ?? "missing",
      told: history.page.filter((entry): boolean =>
        JSON.stringify(entry.event).includes(`${PAYLOAD}${trial.resultId}`),
      ).length,
    };
  });
}
