import { existsSync, readFileSync } from "node:fs";

import type { BroodsAccountClient } from "../../packages/broods/src/account.ts";
import { runMachineDaemon } from "../../packages/broods/src/cli/machine.ts";
import type { BroodsClient } from "../../packages/broods/src/client.ts";
import type { AsyncStatus } from "../../packages/broods/src/types.ts";

const DEEPSEEK_SMOKE_MODEL = "deepseek-flash";
const MACHINE_CONNECT_TIMEOUT_MS = 15_000;
const RUN_POLL_INTERVAL_MS = 200;
const RUN_POLL_TIMEOUT_MS = 120_000;

export const MODEL_KEY_HINT = "set DEEPSEEK_API_KEY for the full run";

export interface SmokeModel {
  model: { modelId: string; provider: "deepseek" };
  provider: { deepseek: { apiKey: string } };
}

export interface MachineConnection {
  output: () => string;
  sandboxId: string;
  stop: () => Promise<void>;
}

export type VerifyCase = (context: VerifyContext) => Promise<void>;

export interface VerifyContext {
  account: BroodsAccountClient;
  accountSecret: string;
  client: BroodsClient;
  coreLogPath: string;
  gatewayUrl: string;
  hasModelKey: boolean;
  measure: <T>(step: string, fn: () => Promise<T>) => Promise<T>;
  model: SmokeModel;
  runId: string;
}

/** Thrown by assertStep; verify records the step as the failure. */
export class VerifyFailure extends Error {
  constructor(
    readonly step: string,
    readonly detail: string,
  ) {
    super(`${step}: ${detail}`);
  }
}

/** Logs a passed check, or throws VerifyFailure. */
export function assertStep(
  step: string,
  ok: boolean,
  detail: string,
): asserts ok {
  if (!ok) throw new VerifyFailure(step, detail);
  console.log(`  ok  ${step}`);
}

/**
 * Creates a machine sandbox and runs its daemon in-process on the account
 * secret until `stop`, because the `broods machine` CLI needs a dashboard login.
 */
export async function connectMachine(
  context: VerifyContext,
  options: { computer: boolean; name: string },
): Promise<MachineConnection> {
  const { sandboxId } = await context.account.createSandbox({
    name: options.name,
    config: {
      provider: "machine",
      permissionMode: "bypass",
      network: { mode: "allow-all" },
    },
  });
  let output = "";
  const controller = new AbortController();
  const daemon = runMachineDaemon({
    baseUrl: context.gatewayUrl,
    computer: options.computer,
    credential: async (): Promise<string> => context.accountSecret,
    cwd: process.cwd(),
    log: (line: string): void => {
      output += `${line}\n`;
    },
    sandbox: options.name,
    signal: controller.signal,
  }).catch((error: unknown): void => {
    output += `daemon exited: ${String(error)}\n`;
  });
  const stop = async (): Promise<void> => {
    controller.abort();
    await daemon;
  };
  const connected = await context.measure(
    "machine connect",
    (): Promise<true | null> =>
      pollUntil(
        {
          initialIntervalMs: 100,
          maxIntervalMs: 500,
          timeoutMs: MACHINE_CONNECT_TIMEOUT_MS,
        },
        async (): Promise<true | null> =>
          output.includes(`connected as ${options.name}`) ? true : null,
      ),
  );
  if (connected !== true) await stop();
  assertStep(
    "machine daemon connected through the gateway",
    connected === true,
    output,
  );

  return {
    output: (): string => output,
    sandboxId: sandboxId,
    stop: stop,
  };
}

/** The last JSON line of an append-only log that matches, or null. */
export function lastJsonLine<T>(
  path: string,
  matches: (record: T) => boolean,
): T | null {
  if (!existsSync(path)) return null;
  const lines = readFileSync(path, "utf8").split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] as string;
    if (!line) continue;
    try {
      const record = JSON.parse(line) as T;
      if (matches(record)) return record;
    } catch {
      continue;
    }
  }

  return null;
}

/** Repeats attempt with doubling backoff until non-null; null on timeout. */
export async function pollUntil<T>(
  options: {
    initialIntervalMs: number;
    maxIntervalMs: number;
    timeoutMs: number;
  },
  attempt: () => Promise<T | null>,
): Promise<T | null> {
  const deadline = Date.now() + options.timeoutMs;
  let interval = options.initialIntervalMs;
  while (Date.now() < deadline) {
    const result = await attempt();
    if (result !== null) return result;
    await Bun.sleep(Math.min(interval, Math.max(deadline - Date.now(), 0)));
    interval = Math.min(interval * 2, options.maxIntervalMs);
  }

  return null;
}

/** HTTP status of a GET, or null when unreachable. */
export async function probeHttp(url: string): Promise<number | null> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(3_000),
    });

    return response.status;
  } catch {
    return null;
  }
}

/** Starts a background run through the gateway and waits for its final status. */
export async function runToTerminal(
  context: VerifyContext,
  run: {
    agentId: string;
    conversationKey: string;
    eventId: string;
    text: string;
  },
): Promise<AsyncStatus> {
  const accepted = await context.client.runAsync({
    agentId: run.agentId,
    conversationKey: run.conversationKey,
    eventId: run.eventId,
    input: run.text,
  });

  return accepted.wait({
    intervalMs: RUN_POLL_INTERVAL_MS,
    timeoutMs: RUN_POLL_TIMEOUT_MS,
  });
}

/** DeepSeek Flash on DEEPSEEK_API_KEY, or on a dummy key that fails at the provider call. */
export function smokeModel(): { hasModelKey: boolean; model: SmokeModel } {
  const apiKey = process.env.DEEPSEEK_API_KEY;

  return {
    hasModelKey: Boolean(apiKey),
    model: {
      model: { provider: "deepseek", modelId: DEEPSEEK_SMOKE_MODEL },
      provider: { deepseek: { apiKey: apiKey || "none" } },
    },
  };
}
