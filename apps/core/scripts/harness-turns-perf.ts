// Real Pi harness turns in process: Pi through core's adapter and session code, a host-process
// sandbox, the local stack's fake Anthropic model, and the real Convex functions on convex-test.
// The bridge adapters (claude-code, codex, opencode, deepagents) need their CLI in a sandbox.

import { HarnessAgent, type HarnessAgentAdapter } from "@ai-sdk/harness/agent";
import type { Experimental_SandboxProcess } from "@ai-sdk/provider-utils";
import {
  createBroodsSandbox,
  type BroodsSandboxCommandOptions,
  type BroodsSandboxDriverSession,
} from "@broods/ai-sdk-sandbox";
import type { FunctionReference } from "convex/server";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { muteCoreLogs } from "../../../bench/fixtures/mute-core-logs.ts";
import {
  createRuntimeTest,
  seedAccount,
  type RuntimeTest,
} from "../../../packages/convex/bench/harness.bench.ts";
import {
  fakeModel,
  type MessagesRequest,
} from "../../../scripts/local-verify/fake-model.ts";
import { percentile } from "../../../scripts/local-verify/percentile.ts";
import { createConfiguredPiAdapter } from "../src/harness/ai-sdk-harness/adapters/pi.ts";
import {
  openAiSdkHarnessSession,
  parkAiSdkHarnessSession,
} from "../src/harness/ai-sdk-harness/session.ts";
import { SandboxGoneError } from "../src/harness/sandbox/utils.ts";
import { Session } from "../src/harness/session.ts";
import { internal } from "../src/shared/convex/client.ts";
import {
  runtime,
  runtimeMutations,
  runtimeQueries,
} from "../src/shared/convex/runtime.ts";
import type { AgentConfig } from "../src/shared/domain/agent-config.ts";

// The long run reports a near-full context every this many turns, so Pi auto-compacts.
const COMPACT_EVERY = 20;
// Pi compacts above its context window less 16k; claude-haiku-4-5 has 200k.
const FULL_CONTEXT_TOKENS = 190_000;
const LEASE_TTL_MS = 24 * 60 * 60 * 1_000;
const LONG_TURNS = Number(process.env.HARNESS_PERF_LONG_TURNS ?? 120);
const MODEL_ID = "claude-haiku-4-5";
// This turn resumes on a released machine: the next sandbox is new and empty.
const RELEASE_AT = 8;
const TURNS = Number(process.env.HARNESS_PERF_TURNS ?? 40);
// Each run's Pi working directory differs, and Pi names it in the system prompt.
const WORKDIR = /sandbox-\w+-\w+\/pi-[\w-]+/g;
const USER_TEXT =
  "Summarize what changed in the payments service since the last turn. ".repeat(
    24,
  );
// Pi keeps the last ~20k tokens on compaction: longer turns make each compaction cut deep.
const LONG_USER_TEXT = USER_TEXT.repeat(4);

interface Conversation {
  label: string;
  turns: number;
  useStorage: boolean;
  userText: string;
  // Pi compacts every this many turns; the full variant reads every row, as before windows.
  compactEvery?: number;
  fullRead?: boolean;
}

interface Reads {
  rows: number;
}

interface TurnMetrics {
  calls: Record<string, number>;
  // Hash of every request body this turn sent the model.
  modelHash: string;
  openMs: number;
  promptMessages: number;
  readRows: number;
  resumeStateBytes: number;
  saveError?: string;
  storedEntryBytes: number;
  storedRows: number;
  turn: number;
}

muteCoreLogs();
const modelRequests: { messages: number; body: string }[] = [];
let fullContextNext = false;
const model = Bun.serve({
  port: 0,
  fetch: async (request: Request): Promise<Response> => {
    const body = (await request.json()) as MessagesRequest;
    modelRequests.push({
      messages: body.messages.length,
      body: JSON.stringify(body),
    });
    const fullContext = fullContextNext && body.stream === true;
    if (fullContext) fullContextNext = false;

    return fakeModel(body, fullContext ? FULL_CONTEXT_TOKENS : undefined);
  },
});
const root = await mkdtemp(join(tmpdir(), "harness-turns-"));
try {
  const withStorage = await runConversation({
    label: "storage",
    turns: TURNS,
    useStorage: true,
    userText: USER_TEXT,
  });
  const withoutStorage = await runConversation({
    label: "lifecycle",
    turns: TURNS,
    useStorage: false,
    userText: USER_TEXT,
  });
  const long = {
    turns: LONG_TURNS,
    useStorage: true,
    userText: LONG_USER_TEXT,
    compactEvery: COMPACT_EVERY,
  };
  const windowed = await runConversation({ ...long, label: "windowed" });
  const fullRead = await runConversation({
    ...long,
    label: "full",
    fullRead: true,
  });
  console.log(report(withStorage, withoutStorage));
  console.log(longReport(windowed, fullRead));
  const failures = [
    ...storageFailures(withStorage),
    ...windowFailures(windowed, fullRead),
  ];
  for (const failure of failures) console.error(`fail: ${failure}`);
  process.exitCode = failures.length > 0 ? 1 : 0;
} finally {
  await model.stop(true);
  await rm(root, { recursive: true, force: true });
}

async function runConversation(
  conversation: Conversation,
): Promise<TurnMetrics[]> {
  const { compactEvery, label, turns, useStorage } = conversation;
  const test = createRuntimeTest();
  const accountId = await seedAccount(test);
  const conversationKey = `acct:${accountId}:agent:perf:api:pi-${label}`;
  const eventId = `evt_pi_${label}`;
  const admitted = (await test.mutation(internal.runtimeIngress.accept, {
    accountId: accountId as never,
    agentId: "perf",
    conversationKey: conversationKey,
    eventId: eventId,
    runId: `run_${eventId}`,
    idempotencyKey: eventId,
    payloadDigest: eventId,
    events: [{ role: "user", content: "start" }],
    delivery: {
      kind: "http",
      publicEventId: eventId,
      publicConversationKey: conversationKey,
    },
    requestedMode: "followup",
    sizeBytes: 16,
    leaseTtlMs: LEASE_TTL_MS,
    envelopeTtlMs: LEASE_TTL_MS,
    statusTtlMs: LEASE_TTL_MS,
    maxQueuedCount: 10,
    maxQueuedBytes: 1_000_000,
  })) as { ownerGeneration?: number };
  const calls: Record<string, number> = {};
  const reads: Reads = { rows: 0 };
  routeRuntimeTo(test, calls, reads, conversation.fullRead === true);
  const broodsSession = new Session({
    eventId: eventId,
    conversationKey: conversationKey,
    accountId: accountId,
    agentId: "perf",
    ownerGeneration: admitted.ownerGeneration,
  });
  const results: TurnMetrics[] = [];
  for (let turn = 1; turn <= turns; turn += 1) {
    const sandboxRoot = join(
      root,
      `sandbox-${label}-${turn < RELEASE_AT ? "first" : "second"}`,
    );
    await mkdir(sandboxRoot, { recursive: true });
    for (const name of Object.keys(calls)) delete calls[name];
    reads.rows = 0;
    fullContextNext = compactEvery !== undefined && turn % compactEvery === 0;
    const firstRequest = modelRequests.length;
    const stored = await broodsSession.loadHarnessSession();
    const sandbox = hostSandbox(sandboxRoot, turn === RELEASE_AT);
    const agent = new HarnessAgent<HarnessAgentAdapter>({
      harness: createConfiguredPiAdapter(
        agentConfig(),
        useStorage ? broodsSession : undefined,
      ),
      model: MODEL_ID,
      tools: {},
    });
    const openedAt = performance.now();
    const opened = await openAiSdkHarnessSession({
      abortSignal: new AbortController().signal,
      agent: agent,
      sandbox: sandbox,
      stored: stored,
      type: "pi",
    });
    const openMs = performance.now() - openedAt;
    const stream = await agent.stream({
      messages: [
        { role: "user", content: `Turn ${turn}. ${conversation.userText}` },
      ],
      session: opened.nativeSession,
    });
    await stream.consumeStream();
    const saveError = await parkAiSdkHarnessSession({
      ...opened,
      broodsSession: broodsSession,
      reservationKey: "perf",
      successful: true,
      type: "pi",
    }).then(
      (): undefined => undefined,
      (error: unknown): string =>
        error instanceof Error ? error.message : String(error),
    );
    const turnCalls = { ...calls };
    const readRows = reads.rows;
    const saved = await broodsSession.loadHarnessSession();
    const entries = await storedEntries(test, conversationKey);
    results.push({
      calls: turnCalls,
      modelHash: Bun.hash(
        modelRequests
          .slice(firstRequest)
          .map((request) => request.body.replace(WORKDIR, "<workdir>"))
          .join("\n"),
      ).toString(),
      openMs: openMs,
      promptMessages: modelRequests.at(-1)?.messages ?? 0,
      readRows: readRows,
      resumeStateBytes: Buffer.byteLength(
        JSON.stringify(saved?.resumeState ?? null),
      ),
      saveError: saveError,
      storedEntryBytes: entries.bytes,
      storedRows: entries.rows,
      turn: turn,
    });
    if (saveError) break;
  }

  return results;
}

function agentConfig(): AgentConfig {
  return {
    harness: { type: "pi" },
    model: { provider: "anthropic", modelId: MODEL_ID },
    provider: {
      anthropic: {
        apiKey: "sk-ant-perf",
        base_url: `http://127.0.0.1:${model.port}`,
      },
    },
  };
}

// A released machine fails its resume once; core's fallback then creates a fresh one.
function hostSandbox(
  sandboxRoot: string,
  released: boolean,
): ReturnType<typeof createBroodsSandbox> {
  const spawn = (
    options: BroodsSandboxCommandOptions,
  ): Experimental_SandboxProcess & { exited: Promise<number> } => {
    const child = Bun.spawn(["/bin/sh", "-c", options.command], {
      cwd: options.workingDirectory ?? sandboxRoot,
      env: { ...process.env, ...options.env },
      stdout: "pipe",
      stderr: "pipe",
    });

    return {
      pid: child.pid,
      stdout: child.stdout,
      stderr: child.stderr,
      exited: child.exited,
      wait: async (): Promise<{ exitCode: number }> => ({
        exitCode: await child.exited,
      }),
      kill: async (): Promise<void> => child.kill(),
    };
  };
  const session: BroodsSandboxDriverSession = {
    id: "host",
    description: "Host process sandbox for harness perf",
    defaultWorkingDirectory: sandboxRoot,
    ports: [],
    runCommand: async (
      options,
    ): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
      const child = spawn(options);
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);

      return { exitCode: exitCode, stdout: stdout, stderr: stderr };
    },
    spawnCommand: async (options): Promise<Experimental_SandboxProcess> =>
      spawn(options),
    readFile: async (options): Promise<Uint8Array> =>
      new Uint8Array(
        await readFile(options.path).catch(() => new Uint8Array()),
      ),
    writeFile: async (options): Promise<void> => {
      await mkdir(dirname(options.path), { recursive: true });
      await writeFile(options.path, options.content);
    },
    stop: async (): Promise<void> => {},
  };

  return createBroodsSandbox({
    driver: {
      createSession: async () => ({ session: session, isFirstCreate: true }),
      resumeSession: async (): Promise<BroodsSandboxDriverSession> => {
        if (released) throw new SandboxGoneError("machine released");

        return session;
      },
    },
  });
}

function report(
  withStorage: TurnMetrics[],
  withoutStorage: TurnMetrics[],
): string {
  const checkpoints = [
    ...new Set([1, 2, 5, RELEASE_AT, 10, 20, 30, TURNS]),
  ].filter((turn) => turn <= TURNS);
  const row = (label: string, results: TurnMetrics[], turn: number): string => {
    const result = results.find((entry) => entry.turn === turn);
    if (!result) {
      const failed = results.at(-1);

      return `| ${label} | ${turn} | not reached: save refused at turn ${failed?.turn} (${failed?.saveError}) | | | | | |`;
    }
    const calls = Object.entries(result.calls)
      .map(([name, count]): string => `${name} ${count}`)
      .join(", ");
    const total = Object.values(result.calls).reduce(
      (sum, count) => sum + count,
      0,
    );

    return `| ${label} | ${turn} | ${result.resumeStateBytes} | ${result.storedEntryBytes} | ${total} (${calls}) | ${result.openMs.toFixed(1)} | ${result.promptMessages} | ${result.saveError ?? "saved"} |`;
  };
  const opens = (results: TurnMetrics[]): string => {
    const values = results.slice(1).map((result) => result.openMs);

    return `p50 ${percentile(values, 0.5).toFixed(1)} ms, p95 ${percentile(values, 0.95).toFixed(1)} ms`;
  };

  return [
    `### Pi harness turns (${process.platform}-${process.arch}, real Pi ${TURNS} turns, fake model, Convex in memory)`,
    "",
    "| mode | turn | resume-state bytes | entry bytes in Convex | Convex calls this turn | resume ms | messages sent to model | save |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...checkpoints.map((turn) =>
      row("Convex sessionStorage", withStorage, turn),
    ),
    ...checkpoints.map((turn) =>
      row("lifecycle data only", withoutStorage, turn),
    ),
    "",
    `turn ${RELEASE_AT} resumes on a released machine (a new, empty sandbox).`,
    `resume (open) after turn 1: storage ${opens(withStorage)}; lifecycle data ${opens(withoutStorage)}`,
  ].join("\n");
}

function longReport(windowed: TurnMetrics[], fullRead: TurnMetrics[]): string {
  const checkpoints = [
    ...new Set([
      1,
      COMPACT_EVERY,
      COMPACT_EVERY + 1,
      40,
      60,
      80,
      100,
      LONG_TURNS,
    ]),
  ].filter((turn) => turn <= LONG_TURNS);
  const row = (label: string, results: TurnMetrics[], turn: number): string => {
    const result = results.find((entry) => entry.turn === turn);
    if (!result) return `| ${label} | ${turn} | not reached | | | | |`;

    return `| ${label} | ${turn} | ${result.storedRows} | ${result.readRows} | ${result.calls.readHarnessSessionEntries ?? 0} | ${result.openMs.toFixed(1)} | ${result.promptMessages} |`;
  };
  const opens = (results: TurnMetrics[]): string => {
    const values = results.slice(1).map((result) => result.openMs);

    return `p50 ${percentile(values, 0.5).toFixed(1)} ms, p95 ${percentile(values, 0.95).toFixed(1)} ms`;
  };

  return [
    "",
    `### Pi long conversation (${LONG_TURNS} turns, Pi compacts every ${COMPACT_EVERY})`,
    "",
    "| read | turn | rows stored | rows read to resume | read calls | resume ms | messages sent to model |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...checkpoints.map((turn) => row("windowed", windowed, turn)),
    ...checkpoints.map((turn) => row("full (before)", fullRead, turn)),
    "",
    `resume: windowed ${opens(windowed)}; full ${opens(fullRead)}. Every turn's model requests match between the two.`,
  ].join("\n");
}

// Core's Session calls Convex through `runtime`; here every call lands on convex-test and counts.
function routeRuntimeTo(
  test: RuntimeTest,
  calls: Record<string, number>,
  reads: Reads,
  fullRead: boolean,
): void {
  const count = (name: string): void => {
    calls[name] = (calls[name] ?? 0) + 1;
  };
  const query: typeof runtime.query = async (name, args) => {
    count(name);
    const { leafEntryId: _leaf, ...withoutLeaf } = args as {
      leafEntryId?: string;
    };
    const result = await test.query(
      runtimeQueries[name] as FunctionReference<"query", "internal">,
      fullRead && name === "readHarnessSessionEntries" ? withoutLeaf : args,
    );
    if (name === "readHarnessSessionEntries") {
      reads.rows += (result as { entries: unknown[] }).entries.length;
    }

    return result;
  };
  const mutate: typeof runtime.mutate = async (name, args) => {
    count(name);

    return test.mutation(
      runtimeMutations[name] as FunctionReference<"mutation", "internal">,
      args,
    );
  };
  runtime.query = query;
  runtime.mutate = mutate;
}

// The windowed read must feed Pi exactly what a full read does, and stop growing with turns.
function windowFailures(
  windowed: TurnMetrics[],
  fullRead: TurnMetrics[],
): string[] {
  const failures: string[] = [];
  if (windowed.length !== LONG_TURNS || fullRead.length !== LONG_TURNS) {
    failures.push(
      `long run stopped at turn ${Math.min(windowed.length, fullRead.length)}`,
    );
  }
  for (const result of [...windowed, ...fullRead]) {
    if (result.saveError) {
      failures.push(`long run turn ${result.turn}: ${result.saveError}`);
    }
  }
  for (const [index, result] of windowed.entries()) {
    if (fullRead[index] && result.modelHash !== fullRead[index].modelHash) {
      failures.push(
        `long run turn ${result.turn}: the model got a different request than from a full read`,
      );
    }
  }
  const half = Math.floor(windowed.length / 2);
  const busiest = (results: TurnMetrics[]): number =>
    Math.max(0, ...results.map((result) => result.readRows));
  const early = busiest(windowed.slice(0, half));
  const late = busiest(windowed.slice(half));
  if (late > early * 1.25) {
    failures.push(
      `long run: the busiest resume read ${late} rows in the second half, ${early} in the first; reads grow with turns`,
    );
  }

  return failures;
}

function storageFailures(results: TurnMetrics[]): string[] {
  const failures: string[] = [];
  if (results.length !== TURNS) {
    failures.push(`stopped at turn ${results.length}`);
  }
  for (const result of results) {
    if (result.saveError) {
      failures.push(`turn ${result.turn}: ${result.saveError}`);
    }
    if (result.promptMessages !== 2 * result.turn - 1) {
      failures.push(
        `turn ${result.turn}: Pi sent ${result.promptMessages} messages, history holds ${2 * result.turn - 1}`,
      );
    }
    if (result.resumeStateBytes > 1_024) {
      failures.push(
        `turn ${result.turn}: resume state is ${result.resumeStateBytes} bytes`,
      );
    }
  }

  return failures;
}

async function storedEntries(
  test: RuntimeTest,
  conversationKey: string,
): Promise<{ bytes: number; rows: number }> {
  return test.run(async (ctx) => {
    let bytes = 0;
    let rows = 0;
    for await (const row of ctx.db
      .query("runtimeHarnessSessionEntries")
      .withIndex("by_conversationKey_and_sessionId_and_sequence", (q) =>
        q.eq("conversationKey", conversationKey),
      )) {
      bytes += row.entry.length;
      rows += 1;
    }

    return { bytes: bytes, rows: rows };
  });
}
