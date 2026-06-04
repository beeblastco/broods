/**
 * E2B-backed sandbox executor.
 * Keep E2B SDK adaptation here. A real VM: run the bash `code` as-is in the
 * workspace directory. Persistent mode reserves one sandbox per workspace,
 * reconnecting by stored id (E2B auto-pauses it on idle and connect resumes it).
 */

import { optionalEnv } from "../../_shared/env.ts";
import { MAX_CONCURRENT_BACKGROUND_JOBS, resolveSandboxLifecycle } from "../../_shared/sandbox.ts";
import { Sandbox } from "e2b";
import type {
  SandboxExecutor,
  SandboxExecutorConfig,
  SandboxJobHandle,
  SandboxJobLogs,
  SandboxJobRequest,
  SandboxJobStatus,
  SandboxRunRequest,
  SandboxRunResult,
} from "./types.ts";
import { configString, isRecordObject, isSandboxGoneError, shellQuote, stringRecord, truncateText, workspacePath } from "./utils.ts";
import { generateJobId, launchScript, logsScript, parseJobStatus, statusScript, stopScript } from "./jobs.ts";
import { claimSandboxInstance, deleteSandboxInstance, getSandboxExternalId, saveSandboxInstance } from "./instance-store.ts";

export class E2BSandboxExecutor implements SandboxExecutor {
  readonly #config: SandboxExecutorConfig;

  constructor(config: SandboxExecutorConfig) {
    this.#config = config;
  }

  async run(request: SandboxRunRequest): Promise<SandboxRunResult> {
    const startedAt = Date.now();
    const persistent = this.#persistent(request);
    const sandbox = await this.#acquire(request);
    const cwd = persistent ? this.#workDir(request.namespace!) : workspacePath(request);

    try {
      if (persistent && cwd) {
        await this.#shell(sandbox, `mkdir -p ${shellQuote(cwd)}`);
      }
      const result = await sandbox.commands.run(request.code, {
        ...(cwd ? { cwd } : {}),
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
    const ns = this.#requirePersistent(request);
    const sandbox = await this.#acquire(request);
    const workDir = this.#workDir(ns);
    await this.#shell(sandbox, `mkdir -p ${shellQuote(workDir)}`);
    const jobId = request.jobId ?? generateJobId();
    const script = launchScript(this.#jobsDir(ns), jobId, workDir, request.code, {
      maxConcurrentJobs: MAX_CONCURRENT_BACKGROUND_JOBS,
      ...(request.callback ? { callback: request.callback } : {}),
    });
    const result = await sandbox.commands.run(script, { envs: { ...stringRecord(this.#config.envVars) } });
    if ((result.exitCode ?? 0) !== 0) {
      throw new Error([result.stderr, result.error].filter(Boolean).join("\n") || "failed to launch background job");
    }
    return { jobId };
  }

  async jobStatus(request: SandboxJobRequest): Promise<SandboxJobStatus> {
    const { sandbox, jobsDir } = await this.#jobContext(request);
    return parseJobStatus(request.jobId, await this.#shell(sandbox, statusScript(jobsDir, request.jobId)));
  }

  async jobLogs(request: SandboxJobRequest): Promise<SandboxJobLogs> {
    const bytes = request.outputLimitBytes ?? 64 * 1024;
    const { sandbox, jobsDir } = await this.#jobContext(request);
    const logs = truncateText(await this.#shell(sandbox, logsScript(jobsDir, request.jobId, bytes)), bytes);
    return { jobId: request.jobId, logs: logs.value, truncated: logs.truncated };
  }

  async stopJob(request: SandboxJobRequest): Promise<SandboxJobStatus> {
    const { sandbox, jobsDir } = await this.#jobContext(request);
    await this.#shell(sandbox, stopScript(jobsDir, request.jobId));
    // Report the real terminal state: a job that had already finished keeps its
    // own exit code instead of being recorded as killed.
    return parseJobStatus(request.jobId, await this.#shell(sandbox, statusScript(jobsDir, request.jobId)));
  }

  async release(request: { namespace: string }): Promise<void> {
    const externalId = await getSandboxExternalId("e2b", request.namespace);
    if (!externalId) return;
    try {
      await Sandbox.kill(externalId, e2bApiOptions(this.#config));
    } catch (err) {
      // Already gone => safe to forget. Wrong creds / transient => propagate so a
      // caller iterating multiple configs can try the next one.
      if (!isSandboxGoneError(err)) throw err;
    }
    await deleteSandboxInstance("e2b", request.namespace).catch(() => {});
  }

  #persistent(request: { namespace?: string }): boolean {
    return this.#config.persistent === true && !!request.namespace;
  }

  #requirePersistent(request: { namespace?: string }): string {
    if (!this.#persistent(request)) {
      throw new Error("background jobs require a persistent e2b sandbox with a workspace");
    }
    return request.namespace!;
  }

  #workDir(namespace: string): string {
    const options = isRecordObject(this.#config.options) ? this.#config.options : {};
    const root = (configString(options.workspaceRoot) ?? "/mnt/workspaces").replace(/\/+$/, "");
    return `${root}/${namespace}`;
  }

  #jobsDir(namespace: string): string {
    return `${this.#workDir(namespace)}/.fp-jobs`;
  }

  async #acquire(request: SandboxRunRequest): Promise<Sandbox> {
    if (!this.#persistent(request)) {
      return Sandbox.create(e2bCreateOptions(this.#config, false));
    }
    const ns = request.namespace!;
    const externalId = await getSandboxExternalId("e2b", ns);
    if (externalId) {
      try {
        const sandbox = await Sandbox.connect(externalId, e2bApiOptions(this.#config));
        await saveSandboxInstance("e2b", ns, externalId).catch(() => {});
        return sandbox;
      } catch {
        await deleteSandboxInstance("e2b", ns).catch(() => {});
      }
    }
    const created = await Sandbox.create(e2bCreateOptions(this.#config, true));
    if (await claimSandboxInstance("e2b", ns, created.sandboxId)) {
      return created;
    }
    // Lost a concurrent create race: discard our duplicate and reconnect to the
    // sandbox the winner recorded.
    const winner = await getSandboxExternalId("e2b", ns);
    await Sandbox.kill(created.sandboxId, e2bApiOptions(this.#config)).catch(() => {});
    if (!winner) throw new Error("failed to reserve e2b sandbox (lost create race)");
    return Sandbox.connect(winner, e2bApiOptions(this.#config));
  }

  async #jobContext(request: SandboxJobRequest): Promise<{ sandbox: Sandbox; jobsDir: string }> {
    if (!request.namespace) throw new Error("job operations require a persistent workspace namespace");
    const externalId = await getSandboxExternalId("e2b", request.namespace);
    if (!externalId) throw new Error("no reserved e2b sandbox for this workspace");
    const sandbox = await Sandbox.connect(externalId, e2bApiOptions(this.#config));
    return { sandbox, jobsDir: this.#jobsDir(request.namespace) };
  }

  async #shell(sandbox: Sandbox, code: string): Promise<string> {
    const result = await sandbox.commands.run(code, { envs: { ...stringRecord(this.#config.envVars) } });
    return result.stdout ?? "";
  }
}

function e2bApiOptions(config: SandboxExecutorConfig): Record<string, unknown> {
  const options = isRecordObject(config.options) ? config.options : {};
  const apiKey = configString(options.apiKey) ?? optionalEnv("E2B_API_KEY");
  return {
    ...(apiKey ? { apiKey } : {}),
    timeoutMs: resolveSandboxLifecycle(config.lifecycle).idleTimeoutSeconds * 1000,
  };
}

function e2bCreateOptions(config: SandboxExecutorConfig, persistent: boolean): Record<string, unknown> {
  const options = isRecordObject(config.options) ? config.options : {};
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
