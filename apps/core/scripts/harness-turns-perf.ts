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

const LEASE_TTL_MS = 24 * 60 * 60 * 1_000;
const MODEL_ID = "claude-haiku-4-5";
// This turn resumes on a released machine: the next sandbox is new and empty.
const RELEASE_AT = 8;
const TURNS = Number(process.env.HARNESS_PERF_TURNS ?? 40);
const USER_TEXT =
  "Summarize what changed in the payments service since the last turn. ".repeat(
    24,
  );

interface TurnMetrics {
  calls: Record<string, number>;
  openMs: number;
  promptMessages: number;
  resumeStateBytes: number;
  saveError?: string;
  storedEntryBytes: number;
  turn: number;
}

muteCoreLogs();
const modelRequests: number[] = [];
const model = Bun.serve({
  port: 0,
  fetch: async (request: Request): Promise<Response> => {
    const body = (await request.json()) as MessagesRequest;
    modelRequests.push(body.messages.length);

    return fakeModel(body);
  },
});
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
    const sandbox = hostSandbox(sandboxRoot, turn === RELEASE_AT);
    const agent = new HarnessAgent<HarnessAgentAdapter>({
      harness: createConfiguredPiAdapter(
        agentConfig(),
        useStorage ? broodsSession : undefined,
      ),
      sandbox: sandbox,
      model: MODEL_ID,
      tools: {},
    });
    const openedAt = performance.now();
    const nativeSession = await openAiSdkHarnessSession({
      abortSignal: new AbortController().signal,
      agent: agent,
      sandbox: sandbox,
      stored: stored,
      type: "pi",
    });
    const openMs = performance.now() - openedAt;
    const stream = await agent.stream({
      messages: [{ role: "user", content: `Turn ${turn}. ${USER_TEXT}` }],
      session: nativeSession,
    });
    await stream.consumeStream();
    const saveError = await parkAiSdkHarnessSession({
      broodsSession: broodsSession,
      nativeSession: nativeSession,
      reservationKey: "perf",
      successful: true,
      type: "pi",
    }).then(
      (): undefined => undefined,
      (error: unknown): string =>
        error instanceof Error ? error.message : String(error),
    );
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

async function storedEntryBytes(
  test: RuntimeTest,
  conversationKey: string,
): Promise<number> {
  return test.run(async (ctx): Promise<number> => {
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
