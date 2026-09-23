/**
 * What every local-verify case gets: the context `local-stack.ts verify` builds
 * once (gateway, account, model) and the HTTP helpers that drive the stack
 * through the gateway, the way a client would.
 */

import { existsSync, readFileSync } from "node:fs";

import type { AgentConfig } from "../../packages/broods/src/contracts.ts";

const DEEPSEEK_SMOKE_MODEL = "deepseek-flash";
// Without DEEPSEEK_API_KEY runs keep the same provider path and fail at the
// provider call, which still proves routing, auth, config and storage.
const NO_KEY = "sk-local-smoke-no-key";
const RUN_POLL_TIMEOUT_MS = 120_000;

export const MODEL_KEY_HINT = "set DEEPSEEK_API_KEY for the full run";

export interface RunStatus {
  response?: unknown;
  status?: string;
}

export interface SmokeModel {
  model: { modelId: string; provider: "deepseek" };
  provider: { deepseek: { apiKey: string } };
}

/** One feature check. Cases run in registry order and share one account. */
export interface VerifyCase {
  name: string;
  run: (context: VerifyContext) => Promise<void>;
}

export interface VerifyContext {
  accountSecret: string;
  coreLogPath: string;
  gatewayUrl: string;
  /** False without DEEPSEEK_API_KEY: runs end `failed`, and cases that need a real reply skip. */
  hasModelKey: boolean;
  /** Times `fn` into the verify perf record under `step`. */
  measure: <T>(step: string, fn: () => Promise<T>) => Promise<T>;
  model: SmokeModel;
  /** Unique per verify run, for names and event ids. */
  runId: string;
}

/** A failed check. `verify` catches it, records perf, and exits 1. */
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

/** Creates an agent on the smoke model and returns its id. */
export async function createAgent(
  context: VerifyContext,
  name: string,
  config: Partial<AgentConfig>,
): Promise<string> {
  const response = await httpJson(`${context.gatewayUrl}/v1/agents`, {
    method: "POST",
    token: context.accountSecret,
    body: { name: name, config: { ...context.model, ...config } },
  });
  const agentId = (response.body as { agentId?: string }).agentId;
  assertStep(
    `create agent ${name} (config plane via gateway)`,
    response.status === 201 && typeof agentId === "string",
    `status ${response.status}: ${JSON.stringify(response.body)}`,
  );

  return agentId;
}

export async function httpJson(
  url: string,
  options: { body?: unknown; method: string; token: string },
): Promise<{ body: unknown; status: number }> {
  const response = await fetch(url, {
    method: options.method,
    signal: AbortSignal.timeout(15_000),
    headers: {
      Authorization: `Bearer ${options.token}`,
      "Content-Type": "application/json",
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON, keep the raw text
  }

  return { body: body, status: response.status };
}

// The logs are append-only, one JSON object per line, so walk from the end and
// stop at the first match instead of parsing the whole file.
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
      // A partial line from a log that is still being written.
    }
  }

  return null;
}

export async function pollRunStatus(
  statusUrl: string,
  token: string,
): Promise<RunStatus> {
  const doc = await pollUntil(
    {
      initialIntervalMs: 200,
      maxIntervalMs: 1_500,
      timeoutMs: RUN_POLL_TIMEOUT_MS,
    },
    async () => {
      try {
        const response = await httpJson(statusUrl, {
          method: "GET",
          token: token,
        });
        const body = response.body as RunStatus;

        return body.status === "completed" || body.status === "failed"
          ? body
          : null;
      } catch {
        return null; // transient poll failure, retry until the deadline
      }
    },
  );

  return doc ?? { status: "poll-timeout" };
}

// Repeats attempt() with doubling backoff until it returns non-null or
// timeoutMs passes. Returns null on timeout.
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

/** DeepSeek Flash with DEEPSEEK_API_KEY, else the same model on a dummy key. */
export function smokeModel(): { hasModelKey: boolean; model: SmokeModel } {
  const apiKey = process.env.DEEPSEEK_API_KEY;

  return {
    hasModelKey: Boolean(apiKey),
    model: {
      model: { provider: "deepseek", modelId: DEEPSEEK_SMOKE_MODEL },
      provider: { deepseek: { apiKey: apiKey || NO_KEY } },
    },
  };
}

/** Starts a background run through the gateway and returns its status URL. */
export async function startRun(
  context: VerifyContext,
  run: {
    agentId: string;
    conversationKey: string;
    eventId: string;
    text: string;
  },
): Promise<string> {
  const response = await httpJson(`${context.gatewayUrl}/v1/runs`, {
    method: "POST",
    token: context.accountSecret,
    body: {
      agentId: run.agentId,
      eventId: run.eventId,
      conversationKey: run.conversationKey,
      background: true,
      events: [{ role: "user", content: [{ type: "text", text: run.text }] }],
    },
  });
  // The 202 names the run by a server-issued id; polling follows its statusUrl.
  const statusUrl = (response.body as { statusUrl?: string }).statusUrl;
  assertStep(
    `start run ${run.eventId} (core via gateway)`,
    response.status === 202 && typeof statusUrl === "string",
    `status ${response.status}: ${JSON.stringify(response.body)}`,
  );

  return statusUrl.startsWith("/")
    ? `${context.gatewayUrl}${statusUrl}`
    : statusUrl;
}
