import { existsSync, readFileSync } from "node:fs";

import type { BroodsAccountClient } from "../../packages/broods/src/account.ts";
import { runMachineDaemon } from "../../packages/broods/src/cli/machine.ts";
import type { BroodsClient } from "../../packages/broods/src/client.ts";
import type { AsyncStatus } from "../../packages/broods/src/types.ts";
import {
  SELF_HOST_ADMIN,
  SELF_HOST_ISSUER,
} from "../../packages/convex/model/selfHostAuth.ts";

const ANTHROPIC_SMOKE_MODEL = "claude-haiku-5-5";
const MACHINE_CONNECT_TIMEOUT_MS = 15_000;
const RUN_POLL_INTERVAL_MS = 200;
const RUN_POLL_TIMEOUT_MS = 120_000;

export const OK_AGENT = { system: "Reply with the single word OK." } as const;

export const MODEL_KEY_HINT = "set ANTHROPIC_API_KEY for the full run";

export const SELF_HOST_IDENTITY = JSON.stringify({
  subject: SELF_HOST_ADMIN.subject,
  issuer: SELF_HOST_ISSUER,
  tokenIdentifier: `${SELF_HOST_ISSUER}|${SELF_HOST_ADMIN.subject}`,
  email: SELF_HOST_ADMIN.email,
});

export interface SmokeModel {
  model: { modelId: string; provider: "anthropic"; reasoning: "medium" };
  provider: { anthropic: { apiKey: string } };
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
  configPlaneUrl: string;
  convex: (args: readonly string[]) => { ok: boolean; output: string };
  coreLogPath: string;
  edgeUrl: string;
  hasModelKey: boolean;
  measure: <T>(step: string, fn: () => Promise<T>) => Promise<T>;
  model: SmokeModel;
  runId: string;
  // Valid only on requests that skip the edge.
  serviceSecret: string;
  stageTicketSecret: string;
}

export class VerifyFailure extends Error {
  constructor(
    readonly step: string,
    readonly detail: string,
  ) {
    super(`${step}: ${detail}`);
  }
}

export function assertStep(
  step: string,
  ok: boolean,
  detail: string,
): asserts ok {
  if (!ok) throw new VerifyFailure(step, detail);
  console.log(`  ok  ${step}`);
}

// The daemon runs in process on the account key: the `broods machine` CLI needs a login.
export async function connectMachine(
  context: VerifyContext,
  options: {
    computer: boolean;
    name: string;
    envVars?: Record<string, string>;
    timeout?: number;
  },
): Promise<MachineConnection> {
  const { sandboxId } = await context.account.createSandbox({
    name: options.name,
    config: {
      provider: "machine",
      permissionMode: "bypass",
      network: { mode: "allow-all" },
      ...(options.envVars ? { envVars: options.envVars } : {}),
      ...(options.timeout ? { timeout: options.timeout } : {}),
    },
  });
  let output = "";
  const controller = new AbortController();
  const daemon = runMachineDaemon({
    baseUrl: context.edgeUrl,
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

export async function persistentSandboxKeepsFile(
  context: VerifyContext,
  input: { key: string; label: string; path: string; sandboxId: string },
): Promise<void> {
  const { agentId } = await context.account.createAgent({
    name: input.key,
    config: {
      ...context.model,
      agent: {
        system:
          "Use the bash tool to run exactly the command the user gives, then reply with exactly its output and nothing else.",
      },
      sandboxes: [input.sandboxId],
    },
  });
  const turn = (text: string, step: string): Promise<AsyncStatus> =>
    context.measure(step, (): Promise<AsyncStatus> =>
      runToTerminal(context, {
        agentId: agentId,
        conversationKey: input.key,
        eventId: `${input.key}-${step}`,
        text: text,
      }),
    );
  const marker = `${input.label}-${context.runId}`;
  // No prompt holds the reversed marker, so the model cannot pass without reading the file.
  const reversed = marker.split("").reverse().join("");
  const wrote = await turn(
    `Run: echo ${marker} > ${input.path}`,
    `${input.label} write`,
  );
  const read = await turn(`Run: rev ${input.path}`, `${input.label} read`);
  assertStep(
    `a persistent ${input.label} sandbox keeps a file between turns`,
    wrote.status === "completed" &&
      read.status === "completed" &&
      JSON.stringify(read.response ?? "").includes(reversed),
    `${JSON.stringify(wrote)}\n${JSON.stringify(read)}`,
  );
}

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

export function smokeModel(): { hasModelKey: boolean; model: SmokeModel } {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  return {
    hasModelKey: Boolean(apiKey),
    model: {
      model: {
        provider: "anthropic",
        modelId: ANTHROPIC_SMOKE_MODEL,
        reasoning: "medium",
      },
      provider: { anthropic: { apiKey: apiKey || "none" } },
    },
  };
}

export function convexResult(
  context: VerifyContext,
  fn: string,
  args: Record<string, unknown>,
  step: string,
  identity?: string,
): unknown {
  const cli = context.convex([
    "run",
    ...(identity ? ["--identity", identity] : []),
    fn,
    JSON.stringify(args),
  ]);
  assertStep(step, cli.ok, cli.output.slice(-300));

  // `convex run` prints the JSON result after any log lines, and nothing for null.
  const start = cli.output.search(/^[[{"\dn]/m);

  return start < 0 ? null : JSON.parse(cli.output.slice(start));
}
