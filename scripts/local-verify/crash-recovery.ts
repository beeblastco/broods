// `local-stack crash`: core is SIGKILLed between the moment a late result reaches a run and the
// write that stores it, and each result must then be told exactly once and read `stored`.
// `resume`: the sweep hands a detached result to a resume. `read`: `async_status` returned it and
// the step save is held. `child`: a subagent that saves no history read it, its answer is held.

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import {
  scopedDirectConversationKey,
  scopedDirectEventId,
} from "../../apps/core/src/shared/runtime-keys.ts";
import {
  convexResult,
  pollUntil,
  startedChildLog,
  type VerifyContext,
} from "./harness.ts";

const PAYLOAD = "CRASHPAYLOAD-";
// The dead run's lease (15 min), a `maintain` pass (5 min) and the sweep after it; a `pending`
// result is swept 20 min after it settled.
const RECOVERY_WAIT_MS = 25 * 60_000;
// Long enough for the trial to seed the row the child reads.
const CHILD_READ_DELAY_MS = 8_000;

export const CRASH_CASES = ["resume", "read", "child"] as const;
export type CrashCase = (typeof CRASH_CASES)[number];

export interface CrashOptions {
  cases: readonly CrashCase[];
  restartCore: () => Promise<void>;
  tracePath: string;
  trials: number;
  waitMs?: number;
}

export interface CrashTrial {
  case: CrashCase;
  // Where the result may be told: the child's conversation and its parent's, for `child`.
  conversationKeys: string[];
  handback: string;
  resultId: string;
  told: number;
}

interface Crash {
  accountId: string;
  context: VerifyContext;
  held: () => number;
  options: CrashOptions;
}

export async function runCrashRecovery(
  context: VerifyContext,
  options: CrashOptions,
): Promise<CrashTrial[]> {
  const { accountId } = await context.account.getAccount();
  const holdOff = `${options.tracePath}.hold-off`;
  const ledger = `${options.tracePath}.held`;
  const crash: Crash = {
    accountId: accountId,
    context: context,
    held: (): number =>
      existsSync(ledger)
        ? readFileSync(ledger, "utf8").split("\n").length - 1
        : 0,
    options: options,
  };
  rmSync(holdOff, { force: true });
  const trials: CrashTrial[] = [];
  // Always restarted: a held write keeps its run, and its worker slot, until core dies.
  try {
    // One kill per trial: held runs keep worker slots, so trials at once would queue instead.
    for (const kind of ["read", "child"] as const) {
      if (!options.cases.includes(kind)) continue;
      const agents = await readAgents(context, kind);
      for (let index = 0; index < options.trials; index += 1) {
        trials.push(await readTrial(crash, kind, agents, index));
      }
    }
    if (options.cases.includes("resume")) {
      trials.push(...(await resumeTrials(crash)));
    }
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

// The sweep hands each detached result to a resume; the first ones' saves are held.
async function resumeTrials(crash: Crash): Promise<CrashTrial[]> {
  const { context } = crash;
  const { agentId } = await context.account.createAgent({
    name: `crash-${context.runId}`,
    config: { ...context.model, agent: { system: "Say OK." } },
  });
  const heldBefore = crash.held();
  const trials: CrashTrial[] = [];
  for (let index = 0; index < crash.options.trials; index += 1) {
    const turn = await firstTurn(
      crash,
      agentId,
      `crash-${context.runId}-${index}`,
    );
    trials.push({
      case: "resume",
      conversationKeys: [turn.conversationKey],
      handback: "detached",
      resultId: seedResult(context, "resume", turn, true),
      told: 0,
    });
  }
  const picked = await pollUntil(
    { initialIntervalMs: 500, maxIntervalMs: 2_000, timeoutMs: 4 * 60_000 },
    async (): Promise<true | null> => (crash.held() > heldBefore ? true : null),
  );
  if (!picked) throw new Error("the sweep handed no resume to a run");
  // The sweep's pass admits the rest; those wait for a worker and never write.
  await Bun.sleep(5_000);
  console.log(`${crash.held() - heldBefore} resume saves held; killing core`);

  return trials;
}

interface ReadAgents {
  // The agent whose turn reads: the parent that delegates, for `child`.
  agentId: string;
  childId?: string;
}

async function readAgents(
  context: VerifyContext,
  kind: "read" | "child",
): Promise<ReadAgents> {
  // A workspace on a reserved sandbox is what registers async_status. The read touches only
  // Convex, so the sandbox is never reached.
  const sandbox = await context.account.createSandbox({
    name: `crash-${kind}-${context.runId}`,
    config: { provider: "lambda", persistent: true },
  });
  const workspace = await context.account.createWorkspace({
    name: `crash-${kind}-${context.runId}`,
    config: { storage: { provider: "s3" } },
  });
  const reader = await context.account.createAgent({
    name: `crash-${kind}-${context.runId}`,
    config: {
      ...context.model,
      agent: { system: "Check results." },
      sandboxes: [sandbox.sandboxId],
      workspaces: [{ name: "jobs", workspaceId: workspace.workspaceId }],
    },
  });
  if (kind === "read") return { agentId: reader.agentId };
  const parent = await context.account.createAgent({
    name: `crash-parent-${context.runId}`,
    config: {
      ...context.model,
      agent: { system: "Delegate." },
      subagent: { enabled: true, mode: "ephemeral", allowed: [reader.agentId] },
    },
  });

  return { agentId: parent.agentId, childId: reader.agentId };
}

// A turn reads the settled result with `async_status`; the write that would store it is held,
// and core is killed with the read returned and nothing stored.
async function readTrial(
  crash: Crash,
  kind: "read" | "child",
  agents: ReadAgents,
  index: number,
): Promise<CrashTrial> {
  const { context } = crash;
  const publicKey = `crash-${kind}-${context.runId}-${index}`;
  const parent = await firstTurn(crash, agents.agentId, publicKey);
  const heldBefore = crash.held();
  const resultId = `async_tool_${kind}hold_${crypto.randomUUID()}`;
  const eventId = `${publicKey}-t1`;
  const read = `ASYNC_STATUS:${kind === "child" ? CHILD_READ_DELAY_MS : 0}:${resultId}`;
  if (kind === "read") seedResult(context, kind, parent, false, resultId);
  const stream = drain(
    context,
    agents.agentId,
    publicKey,
    eventId,
    kind === "child" ? `SUBAGENT:${agents.childId}:${read}` : read,
  );
  const conversationKeys = [parent.conversationKey];
  if (kind === "child") {
    const child = await pollUntil(
      { initialIntervalMs: 100, maxIntervalMs: 250, timeoutMs: 30_000 },
      async () => startedChildLog(context, eventId),
    );
    if (!child) throw new Error(`trial ${publicKey}: no child started`);
    seedResult(
      context,
      kind,
      {
        conversationKey: child.conversationKey,
        eventId: scopedDirectEventId(
          crash.accountId,
          child.agentId,
          child.taskId,
        ),
      },
      false,
      resultId,
    );
    conversationKeys.unshift(child.conversationKey);
  }
  const held = await pollUntil(
    { initialIntervalMs: 50, maxIntervalMs: 250, timeoutMs: 60_000 },
    async (): Promise<true | null> => (crash.held() > heldBefore ? true : null),
  );
  if (!held)
    throw new Error(`trial ${publicKey}: the write of the read was never held`);
  await crash.options.restartCore();
  await stream;

  return {
    case: kind,
    conversationKeys: conversationKeys,
    handback: "pending",
    resultId: resultId,
    told: 0,
  };
}

async function firstTurn(
  crash: Crash,
  agentId: string,
  publicKey: string,
): Promise<{ conversationKey: string; eventId: string }> {
  await drain(crash.context, agentId, publicKey, `${publicKey}-t0`, "Say OK.");

  return {
    conversationKey: scopedDirectConversationKey(
      crash.accountId,
      agentId,
      publicKey,
    ),
    eventId: scopedDirectEventId(crash.accountId, agentId, `${publicKey}-t0`),
  };
}

// A stream core dies under ends in an error, which is the point of the trial.
async function drain(
  context: VerifyContext,
  agentId: string,
  conversationKey: string,
  eventId: string,
  input: string,
): Promise<void> {
  try {
    for await (const _part of context.client.agent("crash", agentId).stream({
      conversationKey: conversationKey,
      eventId: eventId,
      input: input,
    })) {
      continue;
    }
  } catch {
    return;
  }
}

// Created under `owner`'s turn and settled; `detached` hands it to the recovery sweep at once.
function seedResult(
  context: VerifyContext,
  kind: CrashCase,
  owner: { conversationKey: string; eventId: string },
  detached: boolean,
  resultId = `async_tool_${kind}hold_${crypto.randomUUID()}`,
): string {
  convexResult(
    context,
    "runtime:createAsyncToolResult",
    {
      resultId: resultId,
      parentEventId: `${owner.eventId}:async-bg:${resultId}`,
      conversationKey: owner.conversationKey,
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
  if (detached) {
    convexResult(
      context,
      "runtime:markAsyncToolHandback",
      { resultId: resultId, handback: "detached" },
      "hand the result to the recovery sweep",
    );
  }

  return resultId;
}

function tell(context: VerifyContext, trials: CrashTrial[]): CrashTrial[] {
  return trials.map((trial): CrashTrial => {
    const told = trial.conversationKeys.reduce(
      (sum, conversationKey): number => {
        const history = convexResult<{ page: { event: unknown }[] }>(
          context,
          "runtime:listConversationEvents",
          { conversationKey: conversationKey },
          "read the conversation",
        );

        return (
          sum +
          history.page.filter((entry): boolean =>
            JSON.stringify(entry.event).includes(`${PAYLOAD}${trial.resultId}`),
          ).length
        );
      },
      0,
    );
    const row = convexResult<{ handback?: string } | null>(
      context,
      "runtime:getAsyncToolResult",
      { resultId: trial.resultId },
      "read the result row",
    );

    return { ...trial, handback: row?.handback ?? "missing", told: told };
  });
}
