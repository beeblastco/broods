/**
 * Vercel Sandbox executor.
 * Keep @vercel/sandbox adaptation here. Persistent mode reserves one named
 * sandbox per reservation key and uses Vercel's native lifecycle callbacks.
 */

import { optionalEnv } from "../../_shared/env.ts";
import { MAX_CONCURRENT_BACKGROUND_JOBS, resolveSandboxLifecycle } from "../../_shared/sandbox.ts";
import type { CommandFinished, NetworkPolicy, Sandbox as VercelSandbox } from "@vercel/sandbox";
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
import { configString, isRecordObject, isSandboxGoneError, persistentSandboxName, sandboxReservationKey, shellQuote, stringRecord, truncateText, workspacePath } from "./utils.ts";
import { generateJobId, launchScript, logsScript, parseJobStatus, statusScript, stopScript } from "./jobs.ts";
import { claimSandboxInstance, deleteSandboxInstance, getSandboxExternalId, saveSandboxInstance } from "./instance-store.ts";

type VercelSandboxClass = typeof import("@vercel/sandbox").Sandbox;

export class VercelSandboxExecutor implements SandboxExecutor {
  readonly #config: SandboxExecutorConfig;
  #sandboxClass?: Promise<VercelSandboxClass>;

  constructor(config: SandboxExecutorConfig) {
    this.#config = config;
  }

  async run(request: SandboxRunRequest): Promise<SandboxRunResult> {
    const startedAt = Date.now();
    const persistent = this.#persistent(request);
    const sandbox = await this.#acquire(request);
    const cwd = persistent ? this.#workDir(sandboxReservationKey(request)!) : workspacePath(request);

    try {
      if (cwd) {
        await this.#shell(sandbox, `mkdir -p ${shellQuote(cwd)}`, { cwd: "/" });
      }
      const result = await sandbox.runCommand({
        cmd: "bash",
        args: ["-lc", request.code],
        ...(cwd ? { cwd } : {}),
        env: { ...stringRecord(this.#config.envVars), ...(request.envVars ?? {}) },
        timeoutMs: request.timeoutSeconds * 1000,
      });
      return this.#adaptResult(result, request, startedAt);
    } finally {
      if (!persistent) await sandbox.stop().catch(() => {});
    }
  }

  async prewarm(request: { namespace?: string; reservationKey?: string }): Promise<void> {
    if (!this.#persistent(request)) return;
    await this.#acquire({ code: "", ...request, timeoutSeconds: 30, outputLimitBytes: 1024 });
  }

  async runBackground(request: SandboxRunRequest): Promise<SandboxJobHandle> {
    const ns = this.#requirePersistent(request);
    const sandbox = await this.#acquire(request);
    const workDir = this.#workDir(ns);
    await this.#shell(sandbox, `mkdir -p ${shellQuote(workDir)}`, { cwd: "/" });
    const jobId = request.jobId ?? generateJobId();
    const script = launchScript(this.#jobsDir(ns), jobId, workDir, request.code, {
      maxConcurrentJobs: MAX_CONCURRENT_BACKGROUND_JOBS,
      ...(request.callback ? { callback: request.callback } : {}),
    });
    const result = await sandbox.runCommand({
      cmd: "bash",
      args: ["-lc", script],
      env: { ...stringRecord(this.#config.envVars) },
      timeoutMs: request.timeoutSeconds * 1000,
    });
    if (result.exitCode !== 0) {
      throw new Error(await commandError(result, "failed to launch background job"));
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
    return parseJobStatus(request.jobId, await this.#shell(sandbox, statusScript(jobsDir, request.jobId)));
  }

  async release(request: { namespace?: string; reservationKey?: string }): Promise<void> {
    const key = sandboxReservationKey(request);
    if (!key) return;
    const name = await getSandboxExternalId("vercel", key);
    if (!name) return;
    try {
      const Sandbox = await this.#Sandbox();
      const sandbox = await Sandbox.get({ name, ...vercelAuthOptions(this.#config) });
      await sandbox.delete();
    } catch (err) {
      if (!isSandboxGoneError(err)) throw err;
    }
    await deleteSandboxInstance("vercel", key).catch(() => {});
  }

  #persistent(request: { namespace?: string; reservationKey?: string }): boolean {
    return this.#config.persistent === true && !!sandboxReservationKey(request);
  }

  #requirePersistent(request: { namespace?: string; reservationKey?: string }): string {
    if (!this.#persistent(request)) {
      throw new Error("background jobs require a persistent vercel sandbox reservation key");
    }
    return sandboxReservationKey(request)!;
  }

  #workspaceRoot(): string {
    const options = isRecordObject(this.#config.options) ? this.#config.options : {};
    return (configString(options.workspaceRoot) ?? "/mnt/workspaces").replace(/\/+$/, "");
  }

  #workDir(namespace: string): string {
    return `${this.#workspaceRoot()}/${namespace}`;
  }

  #jobsDir(namespace: string): string {
    return `${this.#workDir(namespace)}/.fp-jobs`;
  }

  async #acquire(request: SandboxRunRequest): Promise<VercelSandbox> {
    const Sandbox = await this.#Sandbox();
    if (!this.#persistent(request)) {
      return Sandbox.create(vercelCreateOptions(this.#config, request, false));
    }

    const key = sandboxReservationKey(request)!;
    const storedName = await getSandboxExternalId("vercel", key);
    if (storedName) {
      try {
        const sandbox = await Sandbox.get({
          name: storedName,
          ...vercelAuthOptions(this.#config),
          onResume: lifecycleCallback(this.#workDir(key), this.#config.onResume),
        });
        await saveSandboxInstance("vercel", key, storedName).catch(() => {});
        return sandbox;
      } catch {
        await deleteSandboxInstance("vercel", key).catch(() => {});
      }
    }

    const name = persistentSandboxName(key);
    const sandbox = await Sandbox.getOrCreate({
      ...vercelCreateOptions(this.#config, request, true),
      name,
      onCreate: lifecycleCallback(this.#workDir(key), this.#config.onCreate),
      onResume: lifecycleCallback(this.#workDir(key), this.#config.onResume),
    });
    if (await claimSandboxInstance("vercel", key, name)) {
      return sandbox;
    }
    const winner = await getSandboxExternalId("vercel", key);
    if (!winner || winner === name) {
      return sandbox;
    }
    await sandbox.delete().catch(() => {});
    return Sandbox.get({
      name: winner,
      ...vercelAuthOptions(this.#config),
      onResume: lifecycleCallback(this.#workDir(key), this.#config.onResume),
    });
  }

  async #jobContext(request: SandboxJobRequest): Promise<{ sandbox: VercelSandbox; jobsDir: string }> {
    const key = sandboxReservationKey(request);
    if (!key) throw new Error("job operations require a persistent sandbox reservation key");
    const name = await getSandboxExternalId("vercel", key);
    if (!name) throw new Error("no reserved vercel sandbox for this workspace");
    const Sandbox = await this.#Sandbox();
    const sandbox = await Sandbox.get({
      name,
      ...vercelAuthOptions(this.#config),
      onResume: lifecycleCallback(this.#workDir(key), this.#config.onResume),
    });
    return { sandbox, jobsDir: this.#jobsDir(key) };
  }

  async #shell(sandbox: VercelSandbox, code: string, opts: { cwd?: string } = {}): Promise<string> {
    const result = await sandbox.runCommand({
      cmd: "bash",
      args: ["-lc", code],
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      env: { ...stringRecord(this.#config.envVars) },
    });
    if (result.exitCode !== 0) {
      throw new Error(await commandError(result, "vercel sandbox setup command failed"));
    }
    return await result.stdout();
  }

  async #adaptResult(result: CommandFinished, request: SandboxRunRequest, startedAt: number): Promise<SandboxRunResult> {
    const [rawStdout, rawStderr] = await Promise.all([result.stdout(), result.stderr()]);
    const stdout = truncateText(rawStdout, request.outputLimitBytes);
    const stderr = truncateText(rawStderr, request.outputLimitBytes);
    return {
      ok: result.exitCode === 0,
      runtime: request.runtime ?? "bash",
      exitCode: result.exitCode,
      stdout: stdout.value,
      stderr: stderr.value,
      durationMs: Date.now() - startedAt,
      truncated: stdout.truncated || stderr.truncated,
      provider: "vercel",
    };
  }

  #Sandbox(): Promise<VercelSandboxClass> {
    this.#sandboxClass ??= import("@vercel/sandbox").then((mod) => mod.Sandbox);
    return this.#sandboxClass;
  }
}

function vercelCreateOptions(
  config: SandboxExecutorConfig,
  request: { envVars?: Record<string, string>; timeoutSeconds: number },
  persistent: boolean,
): Record<string, unknown> {
  const options = isRecordObject(config.options) ? config.options : {};
  const lifecycle = resolveSandboxLifecycle(config.lifecycle);
  return {
    ...vercelAuthOptions(config),
    runtime: configString(options.runtime) ?? "node24",
    persistent,
    timeout: (persistent ? lifecycle.idleTimeoutSeconds : request.timeoutSeconds) * 1000,
    networkPolicy: vercelNetworkPolicy(config),
    env: { ...stringRecord(config.envVars), ...(request.envVars ?? {}) },
    tags: { app: "filthy-panty", provider: "vercel" },
  };
}

function vercelAuthOptions(config: SandboxExecutorConfig): { token: string; teamId: string; projectId: string } {
  const options = isRecordObject(config.options) ? config.options : {};
  const token = configString(options.token) ?? optionalEnv("VERCEL_TOKEN");
  const teamId = configString(options.teamId) ?? optionalEnv("VERCEL_TEAM_ID");
  const projectId = configString(options.projectId) ?? optionalEnv("VERCEL_PROJECT_ID");
  const missing = Object.entries({ token, teamId, projectId })
    .filter(([, value]) => !value)
    .map(([key]) => key);
  if (missing.length > 0) {
    throw new Error(`vercel sandbox auth is missing ${missing.join(", ")}; set config.options.{token,teamId,projectId} or VERCEL_TOKEN/VERCEL_TEAM_ID/VERCEL_PROJECT_ID`);
  }
  return { token: token!, teamId: teamId!, projectId: projectId! };
}

function vercelNetworkPolicy(config: SandboxExecutorConfig): NetworkPolicy {
  const network = config.network ?? { mode: "deny-all" as const };
  if (network.mode === "allow-all") return "allow-all";
  if (network.mode === "deny-all") return "deny-all";
  return {
    ...(network.allowDomains?.length ? { allow: network.allowDomains } : {}),
    ...(network.allowCidrs?.length ? { subnets: { allow: network.allowCidrs } } : {}),
  };
}

function lifecycleCallback(workDir: string, commands?: string[]): ((sandbox: VercelSandbox) => Promise<void>) | undefined {
  if (!commands?.length) return undefined;
  return async (sandbox: VercelSandbox) => {
    const script = ["set -e", `mkdir -p ${shellQuote(workDir)}`, `cd ${shellQuote(workDir)}`, ...commands].join("\n");
    const result = await sandbox.runCommand({ cmd: "bash", args: ["-lc", script] });
    if (result.exitCode !== 0) {
      throw new Error(await commandError(result, "vercel lifecycle hook failed"));
    }
  };
}

async function commandError(result: CommandFinished, fallback: string): Promise<string> {
  const [stderr, stdout] = await Promise.all([result.stderr(), result.stdout()]);
  return [stderr, stdout].filter(Boolean).join("\n") || fallback;
}

