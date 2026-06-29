/**
 * E2B-backed sandbox executor.
 * Keep E2B SDK adaptation here. Commands run in E2B's native sandbox filesystem.
 * Persistent mode reserves one sandbox per key, reconnecting by stored id (E2B
 * auto-pauses it on idle and connect resumes it).
 */

import { optionalEnv } from "../../_shared/env.ts";
import { isPlainObject } from "../../_shared/object.ts";
import { resolveSandboxLifecycle } from "../../_shared/sandbox.ts";
import { Buffer } from "node:buffer";
import { Sandbox } from "e2b";
import type {
  SandboxExecutor,
  SandboxExecutorConfig,
  SandboxJobHandle,
  SandboxRunRequest,
  SandboxRunResult,
} from "./types.ts";
import { configString, isSandboxGoneError, sandboxReservationKey, shellQuote, stringRecord, truncateText } from "./utils.ts";
import { callbackSnippet, generateJobId } from "./jobs.ts";
import { claimSandboxInstance, deleteSandboxInstance, getSandboxExternalId, saveSandboxInstance } from "./instance-store.ts";
import { upsertSandboxInstance } from "../../_shared/storage/convex/sandbox-instances.ts";

export class E2BSandboxExecutor implements SandboxExecutor {
  readonly #config: SandboxExecutorConfig;

  constructor(config: SandboxExecutorConfig) {
    this.#config = config;
  }

  async run(request: SandboxRunRequest): Promise<SandboxRunResult> {
    const startedAt = Date.now();
    const persistent = this.#persistent(request);
    const sandbox = await this.#acquire(request);

    try {
      const result = await sandbox.commands.run(request.code, {
        timeoutMs: request.timeoutSeconds * 1000,
        envs: { ...stringRecord(this.#config.envVars), ...(request.envVars ?? {}) },
      });
      const stdout = truncateText(result.stdout ?? "", request.outputLimitBytes);
      const stderr = truncateText([result.stderr, result.error].filter(Boolean).join("\n"), request.outputLimitBytes);
      return {
        ok: (result.exitCode ?? null) === 0,
        runtime: request.runtime ?? "bash",
        exitCode: result.exitCode ?? null,
        stdout: stdout.value,
        stderr: stderr.value,
        durationMs: Date.now() - startedAt,
        truncated: stdout.truncated || stderr.truncated,
        provider: "e2b",
      };
    } finally {
      if (!persistent) await sandbox.kill();
    }
  }

  async runBackground(request: SandboxRunRequest): Promise<SandboxJobHandle> {
    this.#requirePersistent(request);
    const sandbox = await this.#acquire(request);
    const jobId = request.jobId ?? generateJobId();
    const handle = await sandbox.commands.run(e2bBackgroundCommand(request, jobId), {
      background: true,
      timeoutMs: request.timeoutSeconds * 1000,
      envs: { ...stringRecord(this.#config.envVars), ...(request.envVars ?? {}) },
    });
    await handle.disconnect().catch(() => {});
    return { jobId };
  }

  async release(request: { namespace?: string; reservationKey?: string }): Promise<void> {
    const key = sandboxReservationKey(request);
    if (!key) return;
    const externalId = await getSandboxExternalId("e2b", key);
    if (!externalId) return;
    try {
      await Sandbox.kill(externalId, e2bApiOptions(this.#config));
    } catch (err) {
      // Already gone => safe to forget. Wrong creds / transient => propagate so a
      // caller iterating multiple configs can try the next one.
      if (!isSandboxGoneError(err)) throw err;
    }
    await deleteSandboxInstance("e2b", key).catch(() => {});
  }

  #persistent(request: { namespace?: string; reservationKey?: string }): boolean {
    return this.#config.persistent === true && !!sandboxReservationKey(request);
  }

  #requirePersistent(request: { namespace?: string; reservationKey?: string }): void {
    if (!this.#persistent(request)) {
      throw new Error("background jobs require a persistent e2b sandbox reservation key");
    }
  }

  async #acquire(request: SandboxRunRequest): Promise<Sandbox> {
    if (!this.#persistent(request)) {
      return Sandbox.create(e2bCreateOptions(this.#config, false));
    }
    const ns = sandboxReservationKey(request)!;
    const externalId = await getSandboxExternalId("e2b", ns);
    if (externalId) {
      try {
        const sandbox = await Sandbox.connect(externalId, e2bApiOptions(this.#config));
        await saveSandboxInstance("e2b", ns, externalId).catch(() => {});
        await upsertSandboxInstance(this.#config.controlPlane, "e2b", ns, externalId);
        return sandbox;
      } catch {
        await deleteSandboxInstance("e2b", ns).catch(() => {});
      }
    }
    const created = await Sandbox.create(e2bCreateOptions(this.#config, true));
    if (await claimSandboxInstance("e2b", ns, created.sandboxId)) {
      await upsertSandboxInstance(this.#config.controlPlane, "e2b", ns, created.sandboxId);
      return created;
    }
    // Lost a concurrent create race: discard our duplicate and reconnect to the
    // sandbox the winner recorded.
    const winner = await getSandboxExternalId("e2b", ns);
    await Sandbox.kill(created.sandboxId, e2bApiOptions(this.#config)).catch(() => {});
    if (!winner) throw new Error("failed to reserve e2b sandbox (lost create race)");
    return Sandbox.connect(winner, e2bApiOptions(this.#config));
  }

}

function e2bBackgroundCommand(request: SandboxRunRequest, jobId: string): string {
  if (!request.callback) {
    return request.code;
  }
  if (!/^[A-Za-z0-9_-]+$/.test(jobId)) {
    throw new Error(`Invalid job id: ${jobId}`);
  }
  const logFile = `/tmp/fp-e2b-job-${jobId}.log`;
  const codeB64 = Buffer.from(request.code, "utf8").toString("base64");
  return [
    `bash -lc "$(printf %s ${shellQuote(codeB64)} | base64 -d)" > ${shellQuote(logFile)} 2>&1`,
    `__rc=$?`,
    callbackSnippet(request.callback, logFile),
    `rm -f ${shellQuote(logFile)}`,
    `exit "$__rc"`,
  ].join("\n");
}

function e2bApiOptions(config: SandboxExecutorConfig): Record<string, unknown> {
  const options = isPlainObject(config.options) ? config.options : {};
  const apiKey = configString(options.apiKey) ?? optionalEnv("E2B_API_KEY");
  return {
    ...(apiKey ? { apiKey } : {}),
    timeoutMs: resolveSandboxLifecycle(config.lifecycle).idleTimeoutSeconds * 1000,
  };
}

function e2bCreateOptions(config: SandboxExecutorConfig, persistent: boolean): Record<string, unknown> {
  const options = isPlainObject(config.options) ? config.options : {};
  const apiKey = configString(options.apiKey) ?? optionalEnv("E2B_API_KEY");
  const template = configString(options.template) ?? configString(options.templateId);
  return {
    ...(apiKey ? { apiKey } : {}),
    ...(template ? { template } : {}),
    // Auto-pause on idle (instead of kill) so a reserved sandbox can be resumed.
    ...(persistent
      ? { timeoutMs: resolveSandboxLifecycle(config.lifecycle).idleTimeoutSeconds * 1000, lifecycle: { onTimeout: "pause" } }
      : {}),
  };
}
