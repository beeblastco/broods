/**
 * `local-stack long-horizon`: long conversations against core started by
 * `up --perf`, so the fake model answers in process and every core call to
 * Convex lands in the trace. Built to compare two commits on the async result
 * hand-back (#1183): status reads of finished and queued results, a mix with
 * bash and text turns, ten conversations at once, and a crash between a status
 * read and its step save (C1). Writes one JSON file per scenario run under
 * `--out`; `long-horizon --summarize <dir>...` turns them into tables.
 *
 * Results are seeded straight into Convex with the admin key, the way a
 * background job's row looks: created `processing` under an earlier turn of
 * the conversation, then settled either directly (a result that finished) or
 * through core's job callback while the turn runs (its resume queues behind
 * the turn). Seeding is untimed and never in core's trace.
 */

import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  closeSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  scopedDirectConversationKey,
  scopedDirectEventId,
} from "../../apps/core/src/shared/runtime-keys.ts";
import {
  assertStep,
  connectMachine,
  pollUntil,
  type VerifyContext,
} from "./harness.ts";

const QUIET_MS = 150;
const QUIET_TIMEOUT_MS = 10_000;
const SAMPLE_INTERVAL_MS = 1_000;
const CLOCK_TICKS = 100;
const QUEUE_RESUME_DELAY_MS = 400;
const QUEUE_CALLBACK_AFTER_MS = 120;
// The fake model's preload holds the history write of a read of such a row.
const HELD_RESULT_PREFIX = "async_tool_hold_";
// A dead owner's lease runs out within 15 minutes, then the queue behind it
// starts; the sweep lists a detached result 2 minutes after it was written.
const C1_RECOVERY_WAIT_MS = 18 * 60 * 1000;
const DRIFT_WINDOW = 20;
const PAYLOAD_PREFIX = "LHPAYLOAD-";
// Functions whose execution stats the report shows.
const WATCHED_FUNCTIONS = [
  "runtimeIngress:stepBoundary",
  "runtimeIngress:appendConversationEvent",
  "runtime:appendConversationEvent",
  "runtime:markAsyncToolHandback",
  "runtime:markAsyncAgentHandback",
  "runtimeIngress:accept",
  "runtimeIngress:takeNext",
  "runtimeIngress:settle",
  "runtimeIngress:recoverQueued",
  "runtime:getAsyncToolResult",
  "runtime:listConversationEvents",
];

export type ScenarioName = "L1" | "L2" | "L3" | "L4" | "C1";

export interface LongHorizonOptions {
  adminKey: string;
  convexContainer: string;
  convexUrl: string;
  label: string;
  outDir: string;
  pids: () => { core?: number; gateway?: number };
  /** SIGKILLs core and starts it again, for C1. */
  restartCore: () => Promise<void>;
  runs: number;
  scenarios: ScenarioName[];
  tracePath: string;
  /** Overrides C1's wait for recovery after the restart. */
  c1WaitMs?: number;
  /** Overrides the turn counts, for a quick try of the harness. */
  turns?: number;
}

type TurnKind = "bash" | "text" | "status" | "queued-status";

interface TurnRecord {
  calls: number;
  conversation: number;
  error?: string;
  fns: Record<string, number>;
  index: number;
  /** Turn start to its last Convex call, a queued resume behind it included. */
  idleMs: number;
  kind: TurnKind;
  streamMs: number;
}

interface ProcessSample {
  at: number;
  cpuPercent: number;
  rssMb: number;
}

interface DockerSample {
  at: number;
  cpuPercent: number;
  memMb: number;
}

interface FunctionExecution {
  executionMs: number;
  fn: string;
  readBytes: number;
  readDocs: number;
  writeBytes: number;
  writeDocs: number;
}

interface RowCounts {
  conversationEvents: number;
  /** How many seeded results the saved history carries 0, 1, 2... times. */
  told: Record<string, number>;
  queuedEnvelopes: number;
  processingEnvelopes: number;
  resultRows: Record<string, number>;
}

interface CorrectnessRecord {
  conversation: number;
  handback: string;
  resultId: string;
  told: number;
}

export interface ScenarioRun {
  callsByFunction: Record<string, number>;
  correctness?: CorrectnessRecord[];
  docker: DockerSample[];
  functions: FunctionExecution[];
  label: string;
  processes: { core: ProcessSample[]; gateway: ProcessSample[] };
  rows: RowCounts;
  run: number;
  scenario: ScenarioName;
  startedAt: string;
  totalCalls: number;
  turns: TurnRecord[];
  wallMs: number;
}

interface Conversation {
  index: number;
  publicKey: string;
  scopedKey: string;
  /** The scoped event id of the conversation's first turn, the parent of each seeded result. */
  parentEventId: string;
  resultIds: string[];
}

interface Env {
  accountId: string;
  context: VerifyContext;
  options: LongHorizonOptions;
  statusAgentId: string;
  mixAgentId: string;
  trace: TraceReader;
}

interface AsyncToolRow {
  handback?: string;
  status: string;
}

interface EventPage {
  continueCursor: string | null;
  isDone: boolean;
  page: Array<{ cursor: string; event: unknown }>;
}

interface StreamFunctionLogs {
  entries: Array<{
    executionTime?: number;
    identifier?: string;
    kind: string;
    usageStats?: {
      databaseReadBytes: number;
      databaseReadDocuments: number;
      databaseWriteBytes: number;
      databaseWriteDocuments: number;
    };
  }>;
  newCursor: number;
}

/** Runs every scenario `runs` times and writes each run's JSON under `outDir/label`. */
export async function runLongHorizon(
  context: VerifyContext,
  options: LongHorizonOptions,
): Promise<boolean> {
  const dir = join(options.outDir, options.label);
  mkdirSync(dir, { recursive: true });
  const machine = await connectMachine(context, {
    computer: false,
    name: `lh-machine-${context.runId}`,
  });
  let failed = false;
  try {
    const account = await context.account.getAccount();
    // A configured async tool is what registers async_status; the fake model
    // never calls the tool itself.
    const asyncTools = { webSearch_20250305: { async: true } };
    const statusAgent = await context.account.createAgent({
      name: `lh-status-${context.runId}`,
      config: {
        ...context.model,
        agent: { system: "Check results." },
        tools: asyncTools,
      },
    });
    const mixAgent = await context.account.createAgent({
      name: `lh-mix-${context.runId}`,
      config: {
        ...context.model,
        agent: { system: "Use bash and check results." },
        sandboxes: [machine.sandboxId],
        tools: asyncTools,
      },
    });
    const env: Env = {
      accountId: account.accountId,
      context: context,
      options: options,
      statusAgentId: statusAgent.agentId,
      mixAgentId: mixAgent.agentId,
      trace: new TraceReader(options.tracePath),
    };
    for (const scenario of options.scenarios) {
      const runs = scenario === "C1" ? 1 : options.runs;
      for (let run = 1; run <= runs; run += 1) {
        console.log(`\n[${options.label}] ${scenario} run ${run}/${runs}`);
        const result = await runScenario(env, scenario, run);
        const path = join(dir, `${scenario}-run${run}.json`);
        writeFileSync(path, JSON.stringify(result));
        console.log(oneLine(result));
        if (result.turns.some((turn): boolean => turn.error !== undefined)) {
          failed = true;
        }
      }
    }
  } finally {
    await machine.stop();
  }

  return !failed;
}

async function runScenario(
  env: Env,
  scenario: ScenarioName,
  run: number,
): Promise<ScenarioRun> {
  const turns = env.options.turns;
  const tag = `${scenario.toLowerCase()}-${run}-${Date.now().toString(36)}`;
  const sampler = new ResourceSampler(env.options);
  const functions = new FunctionLogPoller(env.options);
  await functions.start();
  sampler.start();
  const traceStart = env.trace.lineCount();
  const startedAt = Date.now();
  let records: TurnRecord[] = [];
  let conversations: Conversation[] = [];
  let correctness: CorrectnessRecord[] | undefined;
  try {
    if (scenario === "L1" || scenario === "L2") {
      const conversation = await openConversation(
        env,
        env.statusAgentId,
        tag,
        0,
      );
      conversations = [conversation];
      records = await sequentialTurns(
        env,
        env.statusAgentId,
        conversation,
        turns ?? 200,
        (): TurnKind => (scenario === "L1" ? "status" : "queued-status"),
      );
    } else if (scenario === "L3") {
      const conversation = await openConversation(env, env.mixAgentId, tag, 0);
      conversations = [conversation];
      records = await sequentialTurns(
        env,
        env.mixAgentId,
        conversation,
        turns ?? 200,
        mixKind,
      );
    } else if (scenario === "L4") {
      conversations = await Promise.all(
        Array.from({ length: 10 }, (_, index) =>
          openConversation(env, env.mixAgentId, tag, index),
        ),
      );
      const all = await Promise.all(
        conversations.map((conversation) =>
          concurrentTurns(
            env,
            env.mixAgentId,
            conversation,
            turns ?? 100,
            mixKind,
          ),
        ),
      );
      await waitForQuiet(env.trace);
      records = all.flat();
    } else {
      ({ conversations, correctness } = await crashBetweenReadAndSave(
        env,
        tag,
        turns ?? 20,
      ));
    }
  } finally {
    sampler.stop();
    await functions.stop();
  }
  const wallMs = Date.now() - startedAt;
  const calls = env.trace
    .linesSince(traceStart)
    .filter((fn): boolean => !fn.startsWith("sandbox/machines:"));

  return {
    callsByFunction: countBy(calls),
    ...(correctness ? { correctness: correctness } : {}),
    docker: sampler.docker,
    functions: functions.executions,
    label: env.options.label,
    processes: { core: sampler.core, gateway: sampler.gateway },
    rows: await rowCounts(env, conversations).catch(
      (error: unknown): RowCounts => {
        console.log(`  row counts failed: ${String(error)}`);

        return {
          conversationEvents: -1,
          processingEnvelopes: -1,
          queuedEnvelopes: -1,
          resultRows: {},
          told: {},
        };
      },
    ),
    run: run,
    scenario: scenario,
    startedAt: new Date(startedAt).toISOString(),
    totalCalls: calls.length,
    turns: records,
    wallMs: wallMs,
  };
}

function mixKind(index: number): TurnKind {
  return (["bash", "text", "status"] as const)[index % 3]!;
}

/** Creates a conversation with one text turn, whose event every seeded result names as its parent. */
async function openConversation(
  env: Env,
  agentId: string,
  tag: string,
  index: number,
): Promise<Conversation> {
  const publicKey = `lh-${tag}-c${index}`;
  const firstEvent = `${publicKey}-t0`;
  await streamTurn(env, agentId, publicKey, firstEvent, "Say OK.");

  return {
    index: index,
    publicKey: publicKey,
    scopedKey: scopedDirectConversationKey(env.accountId, agentId, publicKey),
    parentEventId: scopedDirectEventId(env.accountId, agentId, firstEvent),
    resultIds: [],
  };
}

/** One turn at a time, each measured until core goes quiet so its Convex calls are its own. */
async function sequentialTurns(
  env: Env,
  agentId: string,
  conversation: Conversation,
  count: number,
  kindOf: (index: number) => TurnKind,
): Promise<TurnRecord[]> {
  const records: TurnRecord[] = [];
  for (let index = 1; index <= count; index += 1) {
    const kind = kindOf(index);
    const prepared = await prepareTurn(env, conversation, kind);
    const before = env.trace.lineCount();
    const startedAt = Date.now();
    const { error, ms } = await runPreparedTurn(
      env,
      agentId,
      conversation,
      index,
      prepared,
    );
    const doneAt = await waitForConversation(
      env,
      agentId,
      conversation,
      index,
      prepared,
      error,
    );
    await waitForQuiet(env.trace);
    const entries = env.trace
      .entriesSince(before)
      .filter((entry): boolean => !entry.fn.startsWith("sandbox/machines:"));
    const lastAt = Math.max(entries.at(-1)?.at ?? 0, doneAt, startedAt + ms);
    records.push({
      calls: entries.length,
      conversation: conversation.index,
      ...(error ? { error: error } : {}),
      fns: countBy(entries.map((entry): string => entry.fn)),
      idleMs: lastAt - startedAt,
      index: index,
      kind: kind,
      streamMs: ms,
    });
    if (index % 50 === 0) {
      console.log(`  turn ${index}/${count}`);
    }
  }

  return records;
}

/** Turns of one conversation back to back while other conversations run too; calls are only counted in total. */
async function concurrentTurns(
  env: Env,
  agentId: string,
  conversation: Conversation,
  count: number,
  kindOf: (index: number) => TurnKind,
): Promise<TurnRecord[]> {
  const records: TurnRecord[] = [];
  for (let index = 1; index <= count; index += 1) {
    const kind = kindOf(index);
    const prepared = await prepareTurn(env, conversation, kind);
    const { error, ms } = await runPreparedTurn(
      env,
      agentId,
      conversation,
      index,
      prepared,
    );
    await waitForConversation(
      env,
      agentId,
      conversation,
      index,
      prepared,
      error,
    );
    records.push({
      calls: 0,
      conversation: conversation.index,
      ...(error ? { error: error } : {}),
      fns: {},
      idleMs: ms,
      index: index,
      kind: kind,
      streamMs: ms,
    });
  }

  return records;
}

const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "expired"]);

/**
 * Waits until the turn left nothing running in its conversation: a resume of
 * its result that queued behind it, and the turn itself when the conversation
 * was still busy and queued it. Trace quiet alone can end between a turn and
 * the follow-up it promoted.
 * @returns when the last of them finished, or 0 when there was none
 */
async function waitForConversation(
  env: Env,
  agentId: string,
  conversation: Conversation,
  index: number,
  prepared: PreparedTurn,
  error: string | undefined,
): Promise<number> {
  const runs: string[] = [];
  if (prepared.token && prepared.resultId) {
    runs.push(`${conversation.parentEventId}:async-tools:${prepared.resultId}`);
  }
  if (error?.includes("accepted asynchronously")) {
    runs.push(
      scopedDirectEventId(
        env.accountId,
        agentId,
        `${conversation.publicKey}-t${index}`,
      ),
    );
  }
  let doneAt = 0;
  for (const eventId of runs) {
    const finished = await pollUntil(
      { initialIntervalMs: 10, maxIntervalMs: 100, timeoutMs: 60_000 },
      async (): Promise<number | null> => {
        const status = (await convexAdmin(
          env.options,
          "query",
          "runtimeIngress:getStatusByEventId",
          { accountId: env.accountId, agentId: agentId, eventId: eventId },
        )) as { status: string; updatedAt: number } | null;

        return status && TERMINAL_RUN_STATUSES.has(status.status)
          ? status.updatedAt
          : null;
      },
    );
    doneAt = Math.max(doneAt, finished ?? 0);
  }

  return doneAt;
}

interface PreparedTurn {
  input: string;
  /** Completes the job through core while the turn runs, so its resume queues. */
  token?: string;
  resultId?: string;
}

async function prepareTurn(
  env: Env,
  conversation: Conversation,
  kind: TurnKind,
): Promise<PreparedTurn> {
  if (kind === "bash") return { input: "RUN_BASH" };
  if (kind === "text") return { input: "Say OK." };
  if (kind === "status") {
    const resultId = await seedResult(env, conversation, { settle: true });

    return { input: `ASYNC_STATUS:${resultId}`, resultId: resultId };
  }
  const token = crypto.randomUUID();
  const resultId = await seedResult(env, conversation, {
    settle: false,
    token: token,
  });

  return {
    input: `ASYNC_STATUS_AFTER:${QUEUE_RESUME_DELAY_MS}:${resultId}`,
    resultId: resultId,
    token: token,
  };
}

async function runPreparedTurn(
  env: Env,
  agentId: string,
  conversation: Conversation,
  index: number,
  prepared: PreparedTurn,
): Promise<{ error?: string; ms: number }> {
  const turn = streamTurn(
    env,
    agentId,
    conversation.publicKey,
    `${conversation.publicKey}-t${index}`,
    prepared.input,
  );
  if (prepared.token && prepared.resultId) {
    await Bun.sleep(QUEUE_CALLBACK_AFTER_MS);
    const completed = await completeJob(env, prepared.resultId, prepared.token);
    if (completed !== 202) {
      await turn;

      return { error: `job callback answered ${completed}`, ms: 0 };
    }
  }

  return turn;
}

/** Streams one turn to its end; an error is recorded, not thrown, so one bad turn does not end a 200-turn run. */
async function streamTurn(
  env: Env,
  agentId: string,
  conversationKey: string,
  eventId: string,
  input: string,
): Promise<{ error?: string; ms: number }> {
  const startedAt = performance.now();
  try {
    for await (const _part of env.context.client.agent("lh", agentId).stream({
      conversationKey: conversationKey,
      eventId: eventId,
      input: input,
    })) {
      continue;
    }

    return { ms: performance.now() - startedAt };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      ms: performance.now() - startedAt,
    };
  }
}

/**
 * A background-job row of `conversation`, as the run that launched it writes
 * one, settled `completed` at once unless it is left for core's job callback.
 * `detached` hands it to the recovery sweep, like a run that stopped waiting.
 */
async function seedResult(
  env: Env,
  conversation: Conversation,
  options: { settle: boolean; token?: string; detached?: boolean },
): Promise<string> {
  const resultId = `${options.detached ? HELD_RESULT_PREFIX : "async_tool_"}${crypto.randomUUID()}`;
  await convexAdmin(env.options, "mutation", "runtime:createAsyncToolResult", {
    resultId: resultId,
    parentEventId: `${conversation.parentEventId}:async-bg:${resultId}`,
    conversationKey: conversation.scopedKey,
    toolName: "bash",
    toolCallId: `seed-${resultId}`,
    input: { command: "long-horizon seed" },
    delivery: { kind: "async" },
    ...(options.token ? { completionToken: options.token } : {}),
  });
  if (options.settle) {
    await convexAdmin(
      env.options,
      "mutation",
      "runtime:updateAsyncToolResult",
      {
        resultId: resultId,
        status: "completed",
        response: payload(resultId),
        onlyWhenProcessing: true,
      },
    );
  }
  if (options.detached) {
    await convexAdmin(
      env.options,
      "mutation",
      "runtime:markAsyncToolHandback",
      {
        resultId: resultId,
        handback: "detached",
      },
    );
  }
  conversation.resultIds.push(resultId);

  return resultId;
}

function payload(resultId: string): { output: string } {
  return { output: `${PAYLOAD_PREFIX}${resultId}` };
}

/** Core's job callback, as the background job posts it: settles the row and resumes the conversation. */
async function completeJob(
  env: Env,
  resultId: string,
  token: string,
): Promise<number> {
  const response = await fetch(
    `${env.context.edgeUrl}/v1/sandbox-jobs/${encodeURIComponent(resultId)}/complete`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-job-token": token },
      body: JSON.stringify({
        status: "completed",
        response: payload(resultId),
      }),
      signal: AbortSignal.timeout(15_000),
    },
  );
  await response.body?.cancel();

  return response.status;
}

/**
 * C1: a conversation reads a detached result with async_status, and the
 * fake model's preload holds the write that would save the step. Core is
 * SIGKILLed with the read returned and no step saved, then started again;
 * `count` trials, one kill each. The run
 * waits out the dead lease and the sweep. `told` is how many times the
 * conversation's saved history carries the result.
 */
async function crashBetweenReadAndSave(
  env: Env,
  tag: string,
  count: number,
): Promise<{
  conversations: Conversation[];
  correctness: CorrectnessRecord[];
}> {
  // One trial per kill: a held save keeps its worker slot until core dies,
  // so trials at once would queue behind the worker cap instead of reading.
  const conversations: Conversation[] = [];
  for (let index = 0; index < count; index += 1) {
    const conversation = await openConversation(
      env,
      env.statusAgentId,
      tag,
      index,
    );
    conversations.push(conversation);
    const resultId = await seedResult(env, conversation, {
      settle: true,
      detached: true,
    });
    const traceStart = env.trace.lineCount();
    const stream = streamTurn(
      env,
      env.statusAgentId,
      conversation.publicKey,
      `${conversation.publicKey}-crash`,
      `ASYNC_STATUS:${resultId}`,
    );
    const held = await pollUntil(
      { initialIntervalMs: 20, maxIntervalMs: 100, timeoutMs: 30_000 },
      async (): Promise<true | null> =>
        env.trace
          .linesSince(traceStart)
          .some((fn): boolean => fn.startsWith("held:"))
          ? true
          : null,
    );
    assertStep(
      `trial ${index + 1}: the status read returned and its save is held`,
      held === true,
      resultId,
    );
    // The read's own writes (dev marks the row) finished before the step's
    // save was sent.
    await env.options.restartCore();
    await stream;
  }
  const waitMs = env.options.c1WaitMs ?? C1_RECOVERY_WAIT_MS;
  console.log(
    `  core restarted; waiting up to ${waitMs / 60_000} min for the sweep and the dead leases`,
  );
  const deadline = Date.now() + waitMs;
  let records: CorrectnessRecord[] = [];
  while (Date.now() < deadline) {
    records = await correctnessRecords(env, conversations);
    if (records.every((record): boolean => record.told >= 1)) break;
    await Bun.sleep(30_000);
  }
  // Settle time for anything still in flight, so a second telling shows.
  await Bun.sleep(5_000);
  records = await correctnessRecords(env, conversations);

  return { conversations: conversations, correctness: records };
}

async function correctnessRecords(
  env: Env,
  conversations: Conversation[],
): Promise<CorrectnessRecord[]> {
  return Promise.all(
    conversations.map(async (conversation): Promise<CorrectnessRecord> => {
      const resultId = conversation.resultIds[0]!;
      const events = await conversationEvents(env, conversation.scopedKey);
      const row = (await convexAdmin(
        env.options,
        "query",
        "runtime:getAsyncToolResult",
        { resultId: resultId },
      )) as AsyncToolRow | null;

      return {
        conversation: conversation.index,
        handback: row?.handback ?? "missing",
        resultId: resultId,
        told: events.filter((event): boolean =>
          event.includes(`${PAYLOAD_PREFIX}${resultId}`),
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
      env.options,
      "query",
      "runtime:listConversationEvents",
      {
        conversationKey: conversationKey,
        ...(afterCursor ? { afterCursor: afterCursor } : {}),
      },
    )) as EventPage;
    events.push(...page.page.map((row): string => JSON.stringify(row.event)));
    if (page.isDone || !page.continueCursor) return events;
    afterCursor = page.continueCursor;
  }
}

async function rowCounts(
  env: Env,
  conversations: Conversation[],
): Promise<RowCounts> {
  let eventCount = 0;
  const resultRows: Record<string, number> = {};
  const told: Record<string, number> = {};
  for (const conversation of conversations) {
    const events = await conversationEvents(env, conversation.scopedKey);
    eventCount += events.length;
    for (const resultId of conversation.resultIds) {
      const times = String(
        events.filter((event): boolean =>
          event.includes(`${PAYLOAD_PREFIX}${resultId}`),
        ).length,
      );
      told[times] = (told[times] ?? 0) + 1;
      const row = (await convexAdmin(
        env.options,
        "query",
        "runtime:getAsyncToolResult",
        { resultId: resultId },
      )) as AsyncToolRow | null;
      const key = row ? `${row.status}/${row.handback ?? "none"}` : "missing";
      resultRows[key] = (resultRows[key] ?? 0) + 1;
    }
  }
  const keys = new Set(conversations.map((c): string => c.scopedKey));
  const data = env.context.convex([
    "data",
    "runtimeIngressEnvelopes",
    "--limit",
    "8000",
    "--format",
    "jsonLines",
  ]);
  let queued = 0;
  let processing = 0;
  for (const line of data.output.split("\n")) {
    if (!line.startsWith("{")) continue;
    let envelope: { conversationKey: string; status: string };
    try {
      envelope = JSON.parse(line) as typeof envelope;
    } catch {
      continue;
    }
    if (!keys.has(envelope.conversationKey)) continue;
    if (envelope.status === "queued") queued += 1;
    if (envelope.status === "processing") processing += 1;
  }

  return {
    conversationEvents: eventCount,
    told: told,
    processingEnvelopes: processing,
    queuedEnvelopes: queued,
    resultRows: resultRows,
  };
}

/** One call to the local backend with the admin key, which may call internal functions. */
async function convexAdmin(
  options: Pick<LongHorizonOptions, "adminKey" | "convexUrl">,
  kind: "query" | "mutation",
  path: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetch(`${options.convexUrl}/api/${kind}`, {
    method: "POST",
    headers: {
      authorization: `Convex ${options.adminKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ path: path, args: args, format: "json" }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await response.json()) as
    | { status: "success"; value: unknown }
    | { status: "error"; errorMessage: string };
  if (body.status !== "success") {
    throw new Error(`${path}: ${body.errorMessage}`);
  }

  return body.value;
}

// --- trace ---------------------------------------------------------------

interface TraceEntry {
  at: number;
  fn: string;
}

/** Reads the core Convex trace incrementally; a line still being written waits for the next read. */
class TraceReader {
  private offset = 0;
  private readonly entries: TraceEntry[] = [];

  constructor(private readonly path: string) {
    // Earlier runs' lines are not this run's.
    this.offset = existsSync(path) ? statSync(path).size : 0;
  }

  lineCount(): number {
    this.read();

    return this.entries.length;
  }

  entriesSince(index: number): TraceEntry[] {
    this.read();

    return this.entries.slice(index);
  }

  linesSince(index: number): string[] {
    return this.entriesSince(index).map((entry): string => entry.fn);
  }

  size(): number {
    return existsSync(this.path) ? statSync(this.path).size : 0;
  }

  private read(): void {
    const size = this.size();
    if (size <= this.offset) return;
    const buffer = Buffer.alloc(size - this.offset);
    const fd = openSync(this.path, "r");
    try {
      readSync(fd, buffer, 0, buffer.length, this.offset);
    } finally {
      closeSync(fd);
    }
    const text = buffer.toString("utf8");
    const end = text.lastIndexOf("\n") + 1;
    for (const line of text.slice(0, end).split("\n")) {
      if (line) this.entries.push(JSON.parse(line) as TraceEntry);
    }
    this.offset += Buffer.byteLength(text.slice(0, end));
  }
}

async function waitForQuiet(trace: TraceReader): Promise<void> {
  const deadline = Date.now() + QUIET_TIMEOUT_MS;
  let size = -1;
  while (Date.now() < deadline) {
    const next = trace.size();
    if (next === size) return;
    size = next;
    await Bun.sleep(QUIET_MS);
  }
}

// --- resources -----------------------------------------------------------

/** Samples core and gateway (`/proc`) and the Convex container (`docker stats`) every second. */
class ResourceSampler {
  readonly core: ProcessSample[] = [];
  readonly gateway: ProcessSample[] = [];
  readonly docker: DockerSample[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private stats: ChildProcess | undefined;
  private readonly last = new Map<string, { at: number; ticks: number }>();

  constructor(private readonly options: LongHorizonOptions) {}

  start(): void {
    this.sample();
    this.timer = setInterval((): void => this.sample(), SAMPLE_INTERVAL_MS);
    this.stats = spawn(
      "docker",
      ["stats", "--format", "{{json .}}", this.options.convexContainer],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    let buffered = "";
    this.stats.stdout?.on("data", (chunk: Buffer): void => {
      buffered += chunk.toString("utf8");
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        // `docker stats` redraws with escape codes around each JSON line.
        const json = line.slice(line.indexOf("{"), line.lastIndexOf("}") + 1);
        if (!json) continue;
        const stat = JSON.parse(json) as { CPUPerc: string; MemUsage: string };
        this.docker.push({
          at: Date.now(),
          cpuPercent: Number.parseFloat(stat.CPUPerc),
          memMb: toMb(stat.MemUsage.split("/")[0]!.trim()),
        });
      }
    });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.stats?.kill();
  }

  private sample(): void {
    const pids = this.options.pids();
    this.sampleProcess("core", pids.core, this.core);
    this.sampleProcess("gateway", pids.gateway, this.gateway);
  }

  private sampleProcess(
    name: string,
    pid: number | undefined,
    into: ProcessSample[],
  ): void {
    if (!pid) return;
    let stat = "";
    let status = "";
    try {
      stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      status = readFileSync(`/proc/${pid}/status`, "utf8");
    } catch {
      return;
    }
    // Fields after the parenthesized command; utime and stime are 14 and 15.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const ticks = Number(fields[11]) + Number(fields[12]);
    const rssKb = Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0);
    const at = Date.now();
    const key = `${name}:${pid}`;
    const previous = this.last.get(key);
    this.last.set(key, { at: at, ticks: ticks });
    if (!previous) return;
    into.push({
      at: at,
      cpuPercent:
        ((ticks - previous.ticks) / CLOCK_TICKS / ((at - previous.at) / 1000)) *
        100,
      rssMb: rssKb / 1024,
    });
  }
}

function toMb(value: string): number {
  const match = /([\d.]+)\s*([KMGT]?i?B)/.exec(value);
  if (!match) return 0;
  const scale: Record<string, number> = {
    B: 1 / 1024 / 1024,
    KiB: 1 / 1024,
    KB: 1 / 1024,
    MiB: 1,
    MB: 1,
    GiB: 1024,
    GB: 1024,
  };

  return Number(match[1]) * (scale[match[2]!] ?? 1);
}

/** Tails the backend's function log stream, the same one its dashboard reads. */
class FunctionLogPoller {
  readonly executions: FunctionExecution[] = [];
  private cursor = 0;
  private running = false;
  private loop: Promise<void> | undefined;
  private controller = new AbortController();

  constructor(private readonly options: LongHorizonOptions) {}

  async start(): Promise<void> {
    // Skip what is already in the buffer.
    this.cursor = (await this.fetchPage(0, 1_000)).newCursor;
    this.running = true;
    this.loop = this.poll();
  }

  async stop(): Promise<void> {
    // Let the last executions land in the stream.
    await Bun.sleep(1_500);
    this.running = false;
    this.controller.abort();
    await this.loop;
  }

  private async poll(): Promise<void> {
    while (this.running) {
      try {
        const page = await this.fetchPage(this.cursor, 10_000);
        this.cursor = page.newCursor;
        for (const entry of page.entries) {
          if (entry.kind !== "Completion" || !entry.identifier) continue;
          this.executions.push({
            executionMs: (entry.executionTime ?? 0) * 1000,
            fn: entry.identifier,
            readBytes: entry.usageStats?.databaseReadBytes ?? 0,
            readDocs: entry.usageStats?.databaseReadDocuments ?? 0,
            writeBytes: entry.usageStats?.databaseWriteBytes ?? 0,
            writeDocs: entry.usageStats?.databaseWriteDocuments ?? 0,
          });
        }
      } catch {
        if (!this.running) return;
        await Bun.sleep(200);
      }
    }
  }

  private async fetchPage(
    cursor: number,
    timeoutMs: number,
  ): Promise<StreamFunctionLogs> {
    const response = await fetch(
      `${this.options.convexUrl}/api/stream_function_logs?cursor=${cursor}`,
      {
        headers: { authorization: `Convex ${this.options.adminKey}` },
        signal: AbortSignal.any([
          AbortSignal.timeout(timeoutMs),
          this.controller.signal,
        ]),
      },
    );

    return (await response.json()) as StreamFunctionLogs;
  }
}

// --- summary -------------------------------------------------------------

function countBy(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;

  return counts;
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((left, right): number => left - right);

  return sorted[
    Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))
  ]!;
}

function mean(values: number[]): number {
  return values.length === 0
    ? Number.NaN
    : values.reduce((sum, value): number => sum + value, 0) / values.length;
}

/** Least-squares slope of `y` over time, per minute. */
function slopePerMinute(points: Array<{ at: number; y: number }>): number {
  if (points.length < 2) return Number.NaN;
  const t0 = points[0]!.at;
  const xs = points.map((point): number => (point.at - t0) / 60_000);
  const ys = points.map((point): number => point.y);
  const mx = mean(xs);
  const my = mean(ys);
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < xs.length; index += 1) {
    numerator += (xs[index]! - mx) * (ys[index]! - my);
    denominator += (xs[index]! - mx) ** 2;
  }

  return denominator === 0 ? Number.NaN : numerator / denominator;
}

/**
 * A sequential run counts each turn's own calls, the sweep's included when it
 * fell in that turn; concurrent turns share one trace, so L4 divides its total.
 */
function callsPerTurn(run: ScenarioRun): number {
  if (run.turns.length === 0) return Number.NaN;
  const own = run.turns.reduce((sum, turn): number => sum + turn.calls, 0);

  return (own > 0 ? own : run.totalCalls) / run.turns.length;
}

/** Calls per turn of one function, counted the same way as `callsPerTurn`. */
function fnPerTurn(run: ScenarioRun, fn: string): number {
  if (run.turns.length === 0) return Number.NaN;
  const sequential = run.turns.some((turn): boolean => turn.calls > 0);
  const total = sequential
    ? run.turns.reduce((sum, turn): number => sum + (turn.fns[fn] ?? 0), 0)
    : (run.callsByFunction[fn] ?? 0);

  return total / run.turns.length;
}

/** The headline numbers of one run. */
export interface RunMetrics {
  callsPerTurn: number;
  coreCpuMean: number;
  coreRssEnd: number;
  coreRssPeak: number;
  coreRssSlope: number;
  coreRssStart: number;
  dockerCpuMean: number;
  dockerMemEnd: number;
  dockerMemPeak: number;
  dockerMemStart: number;
  driftMs: number;
  errors: number;
  gatewayCpuMean: number;
  gatewayRssEnd: number;
  gatewayRssPeak: number;
  gatewayRssStart: number;
  idleP50: number;
  idleP95: number;
  p50: number;
  p95: number;
  p99: number;
  wallMs: number;
}

export function runMetrics(run: ScenarioRun): RunMetrics {
  const stream = run.turns.map((turn): number => turn.streamMs);
  const idle = run.turns.map((turn): number => turn.idleMs);
  const ordered = [...run.turns].sort(
    (left, right): number => left.index - right.index,
  );
  const first = ordered
    .filter((turn): boolean => turn.index <= DRIFT_WINDOW)
    .map((turn): number => turn.streamMs);
  const maxIndex = Math.max(...ordered.map((turn): number => turn.index));
  const last = ordered
    .filter((turn): boolean => turn.index > maxIndex - DRIFT_WINDOW)
    .map((turn): number => turn.streamMs);
  const core = run.processes.core;
  const gateway = run.processes.gateway;

  return {
    callsPerTurn: callsPerTurn(run),
    coreCpuMean: mean(core.map((sample): number => sample.cpuPercent)),
    coreRssEnd: core.at(-1)?.rssMb ?? Number.NaN,
    coreRssPeak: Math.max(...core.map((sample): number => sample.rssMb)),
    coreRssSlope: slopePerMinute(
      core.map((sample) => ({ at: sample.at, y: sample.rssMb })),
    ),
    coreRssStart: core[0]?.rssMb ?? Number.NaN,
    dockerCpuMean: mean(run.docker.map((sample): number => sample.cpuPercent)),
    dockerMemEnd: run.docker.at(-1)?.memMb ?? Number.NaN,
    dockerMemPeak: Math.max(
      ...run.docker.map((sample): number => sample.memMb),
    ),
    dockerMemStart: run.docker[0]?.memMb ?? Number.NaN,
    driftMs: mean(last) - mean(first),
    errors: run.turns.filter((turn): boolean => turn.error !== undefined)
      .length,
    gatewayCpuMean: mean(gateway.map((sample): number => sample.cpuPercent)),
    gatewayRssEnd: gateway.at(-1)?.rssMb ?? Number.NaN,
    gatewayRssPeak: Math.max(...gateway.map((sample): number => sample.rssMb)),
    gatewayRssStart: gateway[0]?.rssMb ?? Number.NaN,
    idleP50: percentile(idle, 0.5),
    idleP95: percentile(idle, 0.95),
    p50: percentile(stream, 0.5),
    p95: percentile(stream, 0.95),
    p99: percentile(stream, 0.99),
    wallMs: run.wallMs,
  };
}

function oneLine(run: ScenarioRun): string {
  if (run.correctness) {
    const told = countBy(run.correctness.map((r): string => String(r.told)));

    return `  C1 told counts ${JSON.stringify(told)}`;
  }
  const m = runMetrics(run);

  return `  p50 ${m.p50.toFixed(1)} p95 ${m.p95.toFixed(1)} p99 ${m.p99.toFixed(1)} ms, drift ${m.driftMs.toFixed(1)} ms, ${m.callsPerTurn.toFixed(2)} calls/turn, core rss ${m.coreRssStart.toFixed(0)}->${m.coreRssEnd.toFixed(0)} MB, errors ${m.errors}`;
}

function loadRuns(dir: string): ScenarioRun[] {
  return readdirSync(dir)
    .filter((name): boolean => name.endsWith(".json"))
    .map(
      (name): ScenarioRun =>
        JSON.parse(readFileSync(join(dir, name), "utf8")) as ScenarioRun,
    );
}

function medianOf(values: number[]): string {
  const finite = values.filter((value): boolean => Number.isFinite(value));
  if (finite.length === 0) return "-";
  const sorted = [...finite].sort((left, right): number => left - right);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  const digits = Math.abs(median) >= 100 ? 0 : Math.abs(median) >= 10 ? 1 : 2;

  return sorted.length === 1
    ? median.toFixed(digits)
    : `${median.toFixed(digits)} (${sorted[0]!.toFixed(digits)}–${sorted.at(-1)!.toFixed(digits)})`;
}

/** Markdown tables comparing labels (one directory per commit) scenario by scenario. */
export function summarizeLongHorizon(dirs: string[]): string {
  const labelled = dirs.map((dir) => ({
    label: dir.split("/").filter(Boolean).at(-1)!,
    runs: loadRuns(dir),
  }));
  const scenarios = [
    ...new Set(
      labelled.flatMap(({ runs }) => runs.map((run): string => run.scenario)),
    ),
  ].sort();
  const lines: string[] = [];
  const metricRows: Array<[string, keyof RunMetrics]> = [
    ["turn p50 ms", "p50"],
    ["turn p95 ms", "p95"],
    ["turn p99 ms", "p99"],
    ["turn→idle p50 ms", "idleP50"],
    ["turn→idle p95 ms", "idleP95"],
    ["drift ms (last 20 − first 20)", "driftMs"],
    ["Convex calls / turn", "callsPerTurn"],
    ["wall s", "wallMs"],
    ["core RSS start MB", "coreRssStart"],
    ["core RSS peak MB", "coreRssPeak"],
    ["core RSS end MB", "coreRssEnd"],
    ["core RSS slope MB/min", "coreRssSlope"],
    ["core CPU mean %", "coreCpuMean"],
    ["gateway RSS start MB", "gatewayRssStart"],
    ["gateway RSS peak MB", "gatewayRssPeak"],
    ["gateway RSS end MB", "gatewayRssEnd"],
    ["gateway CPU mean %", "gatewayCpuMean"],
    ["convex mem start MB", "dockerMemStart"],
    ["convex mem peak MB", "dockerMemPeak"],
    ["convex mem end MB", "dockerMemEnd"],
    ["convex CPU mean %", "dockerCpuMean"],
    ["turn errors", "errors"],
  ];
  for (const scenario of scenarios) {
    const per = labelled.map(({ label, runs }) => ({
      label: label,
      runs: runs.filter((run): boolean => run.scenario === scenario),
    }));
    lines.push(`### ${scenario}`, "");
    if (scenario === "C1") {
      lines.push(
        `| commit | conversations | told 0 | told 1 | told 2+ | row hand-back at end |`,
        "| --- | --- | --- | --- | --- | --- |",
      );
      for (const { label, runs } of per) {
        const records = runs.flatMap((run) => run.correctness ?? []);
        const told = (match: (n: number) => boolean): number =>
          records.filter((record): boolean => match(record.told)).length;
        lines.push(
          `| ${label} | ${records.length} | ${told((n) => n === 0)} | ${told((n) => n === 1)} | ${told((n) => n >= 2)} | ${JSON.stringify(countBy(records.map((record): string => record.handback)))} |`,
        );
      }
      lines.push("");
      continue;
    }
    const metrics = per.map(({ label, runs }) => ({
      label: label,
      metrics: runs.map(runMetrics),
      runs: runs,
    }));
    lines.push(
      `| metric (median of runs, min–max) | ${metrics.map((m): string => `${m.label} (${m.runs.length} runs)`).join(" | ")} |`,
      `| --- | ${metrics.map((): string => "---").join(" | ")} |`,
    );
    for (const [name, key] of metricRows) {
      lines.push(
        `| ${name} | ${metrics
          .map((m): string =>
            medianOf(
              m.metrics.map((metric): number =>
                key === "wallMs" ? metric[key] / 1000 : metric[key],
              ),
            ),
          )
          .join(" | ")} |`,
      );
    }
    lines.push("", "Convex calls per turn by function (median of runs):", "");
    const fns = [
      ...new Set(
        metrics.flatMap((m) =>
          m.runs.flatMap((run) => [
            ...Object.keys(run.callsByFunction),
            ...run.turns.flatMap((turn) => Object.keys(turn.fns)),
          ]),
        ),
      ),
    ].sort();
    lines.push(
      `| function | ${metrics.map((m): string => m.label).join(" | ")} |`,
      `| --- | ${metrics.map((): string => "---").join(" | ")} |`,
    );
    for (const fn of fns) {
      lines.push(
        `| ${fn} | ${metrics
          .map((m): string =>
            medianOf(m.runs.map((run): number => fnPerTurn(run, fn))),
          )
          .join(" | ")} |`,
      );
    }
    lines.push(
      "",
      "Convex function executions (all runs pooled): calls, mean / p95 ms, mean docs read / written:",
      "",
    );
    lines.push(
      `| function | ${metrics.map((m): string => m.label).join(" | ")} |`,
      `| --- | ${metrics.map((): string => "---").join(" | ")} |`,
    );
    for (const fn of WATCHED_FUNCTIONS) {
      const cells = metrics.map((m): string => {
        const runs = m.runs.length;
        const executions = m.runs.flatMap((run) =>
          run.functions.filter((execution): boolean => execution.fn === fn),
        );
        if (executions.length === 0) return "-";
        const ms = executions.map((execution): number => execution.executionMs);

        return `${(executions.length / runs).toFixed(0)}/run, ${mean(ms).toFixed(2)} / ${percentile(ms, 0.95).toFixed(2)} ms, ${mean(executions.map((e): number => e.readDocs)).toFixed(1)} r / ${mean(executions.map((e): number => e.writeDocs)).toFixed(1)} w`;
      });
      if (cells.every((cell): boolean => cell === "-")) continue;
      lines.push(`| ${fn} | ${cells.join(" | ")} |`);
    }
    lines.push("", "Rows at the end (median of runs):", "");
    lines.push(
      `| rows | ${metrics.map((m): string => m.label).join(" | ")} |`,
      `| --- | ${metrics.map((): string => "---").join(" | ")} |`,
    );
    const rowKeys = [
      ...new Set(
        metrics.flatMap((m) =>
          m.runs.flatMap((run) => Object.keys(run.rows.resultRows)),
        ),
      ),
    ].sort();
    const toldKeys = [
      ...new Set(
        metrics.flatMap((m) =>
          m.runs.flatMap((run) => Object.keys(run.rows.told)),
        ),
      ),
    ].sort();
    const rowValue = (run: ScenarioRun, key: string): number =>
      key.startsWith("told ")
        ? (run.rows.told[key.slice(5)] ?? 0)
        : key === "conversation events"
          ? run.rows.conversationEvents
          : key === "queued envelopes"
            ? run.rows.queuedEnvelopes
            : key === "processing envelopes"
              ? run.rows.processingEnvelopes
              : (run.rows.resultRows[key] ?? 0);
    for (const key of [
      "conversation events",
      "queued envelopes",
      "processing envelopes",
      ...rowKeys.map((rowKey): string => rowKey),
      ...toldKeys.map((toldKey): string => `told ${toldKey}`),
    ]) {
      const label = rowKeys.includes(key)
        ? `result rows ${key}`
        : key.startsWith("told ")
          ? `results the history carries ${key.slice(5)}×`
          : key;
      lines.push(
        `| ${label} | ${metrics.map((m): string => medianOf(m.runs.map((run): number => rowValue(run, key)))).join(" | ")} |`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

/** Per-turn CSVs and per-second resource CSVs of every run, for re-plotting. */
export function exportCsv(dir: string): void {
  for (const run of loadRuns(dir)) {
    const base = join(dir, `${run.scenario}-run${run.run}`);
    writeFileSync(
      `${base}.turns.csv`,
      [
        "index,conversation,kind,stream_ms,idle_ms,convex_calls,error",
        ...run.turns.map(
          (turn): string =>
            `${turn.index},${turn.conversation},${turn.kind},${turn.streamMs.toFixed(2)},${turn.idleMs.toFixed(2)},${turn.calls},${turn.error ? JSON.stringify(turn.error) : ""}`,
        ),
      ].join("\n"),
    );
    writeFileSync(
      `${base}.resources.csv`,
      [
        "at_ms,source,cpu_percent,mem_mb",
        ...run.processes.core.map(
          (s): string =>
            `${s.at},core,${s.cpuPercent.toFixed(2)},${s.rssMb.toFixed(1)}`,
        ),
        ...run.processes.gateway.map(
          (s): string =>
            `${s.at},gateway,${s.cpuPercent.toFixed(2)},${s.rssMb.toFixed(1)}`,
        ),
        ...run.docker.map(
          (s): string =>
            `${s.at},convex-container,${s.cpuPercent.toFixed(2)},${s.memMb.toFixed(1)}`,
        ),
      ].join("\n"),
    );
  }
}
