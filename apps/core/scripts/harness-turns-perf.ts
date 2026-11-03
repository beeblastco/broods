// Real Pi harness turns in process: Pi through core's adapter and session code, a host-process
// sandbox, a loopback fake Anthropic model, and the real Convex functions on convex-test.
// The bridge adapters (claude-code, codex, opencode, deepagents) need their CLI in a sandbox.

import { HarnessAgent, type HarnessAgentAdapter } from "@ai-sdk/harness/agent";
import type { Experimental_SandboxProcess } from "@ai-sdk/provider-utils";
import type { FunctionReference } from "convex/server";
import {
  createBroodsSandbox,
  type BroodsSandboxDriverSession,
} from "@broods/ai-sdk-sandbox";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createRuntimeTest,
  seedAccount,
  type RuntimeTest,
} from "../../../packages/convex/bench/harness.bench.ts";
import {
  createConfiguredPiAdapter,
  createPiSessionLog,
  type PiSessionLog,
} from "../src/harness/ai-sdk-harness/adapters/pi.ts";
import { replaceReleasedMachine } from "../src/harness/ai-sdk-harness/sandbox.ts";
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

const MODEL_ID = "claude-haiku-4-5";
const REPLY =
  "The deployment rolled back after its health check failed. ".repeat(24);
const TURNS = Number(process.env.HARNESS_PERF_TURNS ?? 40);
const USER_TEXT =
  "Summarize what changed in the payments service since the last turn. ".repeat(
    4,
  );
const LEASE_TTL_MS = 24 * 60 * 60 * 1_000;
// This turn resumes on a released machine: the next sandbox is new and empty.
const RELEASE_AT = 8;

interface TurnMetrics {
  calls: Record<string, number>;
  openMs: number;
  promptMessages: number;
  resumeStateBytes: number;
  saveError?: string;
  storedEntryBytes: number;
  turn: number;
  turnMs: number;
}

const modelRequests: number[] = [];
const model = Bun.serve({ port: 0, fetch: answerModel });
const root = await mkdtemp(join(tmpdir(), "harness-turns-"));
try {
  const withStorage = await runConversation(true);
  const withoutStorage = await runConversation(false);
  console.log(report(withStorage, withoutStorage));
  const failures = storageFailures(withStorage);
  for (const failure of failures) console.error(`fail: ${failure}`);
  process.exitCode = failures.length > 0 ? 1 : 0;
} finally {
  await model.stop(true);
  await rm(root, { recursive: true, force: true });
}

async function runConversation(useStorage: boolean): Promise<TurnMetrics[]> {
  const test = createRuntimeTest();
  const accountId = await seedAccount(test);
  const conversationKey = `acct:${accountId}:agent:perf:api:pi-${useStorage}`;
  const eventId = `evt_pi_${useStorage}`;
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
  routeRuntimeTo(test, calls);
  const broodsSession = new Session({
    eventId: eventId,
    conversationKey: conversationKey,
    accountId: accountId,
    agentId: "perf",
    ownerGeneration: admitted.ownerGeneration,
  });
  const results: TurnMetrics[] = [];
  for (let turn = 1; turn <= TURNS; turn += 1) {
    const sandboxRoot = join(
      root,
      `sandbox-${useStorage}-${turn < RELEASE_AT ? "first" : "second"}`,
    );
    await mkdir(sandboxRoot, { recursive: true });
    for (const name of Object.keys(calls)) delete calls[name];
    const stored = await broodsSession.loadHarnessSession();
    const sessionLog = useStorage
      ? createPiSessionLog(
          (sessionId): ReturnType<Session["readHarnessSessionEntries"]> =>
            broodsSession.readHarnessSessionEntries(sessionId),
        )
      : undefined;
    const agent = new HarnessAgent<HarnessAgentAdapter>({
      harness: createConfiguredPiAdapter(agentConfig(), sessionLog?.storage),
      sandbox: hostSandbox(sandboxRoot, turn === RELEASE_AT),
      model: MODEL_ID,
      tools: {},
    });
    const openedAt = performance.now();
    const nativeSession = await openAiSdkHarnessSession({
      abortSignal: new AbortController().signal,
      agent: agent,
      stored: stored,
      type: "pi",
    });
    const openMs = performance.now() - openedAt;
    const startedAt = performance.now();
    const stream = await agent.stream({
      messages: [{ role: "user", content: `Turn ${turn}. ${USER_TEXT}` }],
      session: nativeSession,
    });
    await stream.consumeStream();
    const turnMs = performance.now() - startedAt;
    const saveError = await park(broodsSession, nativeSession, sessionLog);
    const turnCalls = { ...calls };
    const saved = await broodsSession.loadHarnessSession();
    results.push({
      calls: turnCalls,
      openMs: openMs,
      promptMessages: modelRequests.at(-1) ?? 0,
      resumeStateBytes: Buffer.byteLength(
        JSON.stringify(saved?.resumeState ?? null),
      ),
      saveError: saveError,
      storedEntryBytes: await storedEntryBytes(test, conversationKey),
      turn: turn,
      turnMs: turnMs,
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

// The fake answers every turn the same, and records how many messages Pi sent it.
async function answerModel(request: Request): Promise<Response> {
  const body = (await request.json()) as { messages: unknown[] };
  modelRequests.push(body.messages.length);
  const events = [
    {
      type: "message_start",
      message: {
        id: `msg_${modelRequests.length}`,
        type: "message",
        role: "assistant",
        model: MODEL_ID,
        content: [],
        stop_reason: null,
        usage: { input_tokens: 100, output_tokens: 0 },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: REPLY },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 200 },
    },
    { type: "message_stop" },
  ];

  return new Response(
    events
      .map(
        (event): string =>
          `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function hostSandbox(
  sandboxRoot: string,
  released: boolean,
): ReturnType<typeof createBroodsSandbox> {
  const session: BroodsSandboxDriverSession = {
    id: "host",
    description: "Host process sandbox for harness perf",
    defaultWorkingDirectory: sandboxRoot,
    ports: [],
    runCommand: async (options) => {
      const child = Bun.spawn(["/bin/sh", "-c", options.command], {
        cwd: options.workingDirectory ?? sandboxRoot,
        env: { ...process.env, ...options.env },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);

      return { exitCode: exitCode, stdout: stdout, stderr: stderr };
    },
    spawnCommand: async (options): Promise<Experimental_SandboxProcess> => {
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
        wait: async () => ({ exitCode: await child.exited }),
        kill: async () => child.kill(),
      };
    },
    readFile: async (options) =>
      new Uint8Array(
        await readFile(options.path).catch(() => new Uint8Array()),
      ),
    writeFile: async (options) => {
      await mkdir(dirname(options.path), { recursive: true });
      await writeFile(options.path, options.content);
    },
    stop: async () => {},
  };

  return createBroodsSandbox({
    driver: replaceReleasedMachine("pi", {
      createSession: async () => ({ session: session, isFirstCreate: true }),
      resumeSession: async () => {
        if (released) throw new SandboxGoneError("machine released");

        return session;
      },
    }),
  });
}

async function park(
  broodsSession: Session,
  nativeSession: Awaited<ReturnType<typeof openAiSdkHarnessSession>>,
  sessionLog: PiSessionLog | undefined,
): Promise<string | undefined> {
  try {
    await parkAiSdkHarnessSession({
      broodsSession: broodsSession,
      nativeSession: nativeSession,
      reservationKey: "perf",
      sessionLog: sessionLog,
      successful: true,
      type: "pi",
    });

    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function storageFailures(results: TurnMetrics[]): string[] {
  const failures: string[] = [];
  if (results.length !== TURNS)
    failures.push(`stopped at turn ${results.length}`);
  for (const result of results) {
    if (result.saveError)
      failures.push(`turn ${result.turn}: ${result.saveError}`);
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

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right): number => left - right);

  return (
    sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))] ??
    0
  );
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
      .map(([name, count]): string => `${name.split(":").at(-1)} ${count}`)
      .join(", ");

    return `| ${label} | ${turn} | ${result.resumeStateBytes} | ${result.storedEntryBytes} | ${Object.values(result.calls).reduce((sum, count) => sum + count, 0)} (${calls}) | ${result.openMs.toFixed(1)} | ${result.promptMessages} | ${result.saveError ?? "saved"} |`;
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

// Core's Session calls Convex through `runtime`; here every call lands on convex-test and counts.
function routeRuntimeTo(
  test: RuntimeTest,
  calls: Record<string, number>,
): void {
  const count = (name: string): void => {
    calls[name] = (calls[name] ?? 0) + 1;
  };
  const query: typeof runtime.query = async (name, args) => {
    count(name);

    return test.query(
      runtimeQueries[name] as FunctionReference<"query", "internal">,
      args,
    );
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

async function storedEntryBytes(
  test: RuntimeTest,
  conversationKey: string,
): Promise<number> {
  return test.run(async (ctx) => {
    let bytes = 0;
    for await (const row of ctx.db
      .query("runtimeHarnessSessionEntries")
      .withIndex("by_conversationKey_and_sessionId_and_sequence", (q) =>
        q.eq("conversationKey", conversationKey),
      )) {
      bytes += row.entry.length;
    }

    return bytes;
  });
}
