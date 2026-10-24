/**
 * Vercel Sandbox executor.
 * Keep @vercel/sandbox adaptation here. Persistent mode reserves one named
 * sandbox per reservation key. Vercel's session `timeout` is a hard limit, not
 * an idle timer, so each call extends the session to one idle window past its
 * own end, and `maxLifetimeSeconds` retires the sandbox at acquire.
 * With `options.mountAwsS3Buckets`, a workspace run mounts its S3 prefix with
 * mount-s3 before each call, on credentials scoped to that prefix for an hour
 * and kept out of the sandbox env. `config.snapshot` names the image or snapshot it boots, and
 * the Snapshot action captures a reserved sandbox into a new snapshot.
 * `options.networkId` attaches the sandbox to a Secure Compute network.
 */

import { randomUUID } from "node:crypto";
import type {
  CommandFinished,
  NetworkPolicy,
  Sandbox as VercelSandbox,
} from "@vercel/sandbox";
import { upsertSandboxInstance } from "../../shared/convex/sandbox-instances.ts";
import { optionalEnv } from "../../shared/env.ts";
import { toErrorMessage } from "../../shared/errors.ts";
import { logWarn } from "../../shared/log.ts";
import { isPlainObject } from "../../shared/object.ts";
import type { SandboxSpecs } from "../../shared/sandbox-sizes.ts";
import {
  MAX_CONCURRENT_BACKGROUND_JOBS,
  resolveSandboxLifecycle,
} from "../../shared/sandbox.ts";
import {
  claimSandboxInstance,
  deleteSandboxInstance,
  getSandboxExternalId,
  saveSandboxInstance,
} from "./instance-store.ts";
import {
  callbackEnv,
  generateJobId,
  launchScript,
  logsScript,
  parseJobStatus,
  statusScript,
  stopScript,
} from "./jobs.ts";
import {
  type ResolvedS3Mount,
  type S3MountIdentity,
  executorS3Context,
  freshMountScript,
  resolveS3Mount,
  resolveS3MountIdentity,
} from "./s3-mount.ts";
import type {
  SandboxExecutor,
  SandboxExecutorConfig,
  SandboxJobHandle,
  SandboxJobLogs,
  SandboxJobRequest,
  SandboxJobStatus,
  SandboxReleaseRequest,
  SandboxReservationRef,
  SandboxRunRequest,
  SandboxRunResult,
  SandboxSnapshotResult,
} from "./types.ts";
import {
  assertSnapshotBootable,
  configString,
  isSandboxGoneError,
  mergeSandboxEnv,
  meterEphemeralSandbox,
  sandboxNamePrefix,
  sandboxReservationKey,
  shellQuote,
  stringRecord,
  truncateText,
  workspacePath,
} from "./utils.ts";

const GENERATION_LENGTH = 8;
// An ephemeral session runs its setup (the workdir, a workspace mount) before
// the command and is stopped when the call ends, so it gets this long past the
// command's own timeout rather than being cut off mid-command.
const EPHEMERAL_SETUP_SECONDS = 5 * 60;
// Mountpoint for S3's release package. The images ship without it, so a sandbox
// whose snapshot lacks it fetches it once, which needs egress to these hosts.
const MOUNT_LOCK = "/tmp/.fp-s3-mount.lock";
const MOUNT_S3_PACKAGE =
  "https://s3.amazonaws.com/mountpoint-s3-release/latest/${arch}/mount-s3.deb";
// Vercel snapshot ids carry this prefix. Any other `snapshot` names a VCR image.
const SNAPSHOT_ID_PREFIX = "snap_";

type VercelSandboxClass = typeof import("@vercel/sandbox").Sandbox;
type VercelCreateOptions = NonNullable<
  Parameters<VercelSandboxClass["create"]>[0]
>;

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
    const endMeter = persistent
      ? undefined
      : meterEphemeralSandbox(
          this.#config.controlPlane,
          "vercel",
          sandbox.name,
          request.metadata,
          () => vercelSpecs(sandbox),
        );
    const cwd = persistent
      ? this.#workDir(sandboxReservationKey(request)!)
      : workspacePath(request);

    try {
      await this.#ensureS3Mount(sandbox, request);
      if (cwd) {
        await this.#shell(sandbox, `mkdir -p ${shellQuote(cwd)}`, { cwd: "/" });
      }
      if (persistent && cwd) {
        await this.#keepAlive(sandbox, request.timeoutSeconds);
        await this.#runLifecycle(sandbox, sandboxReservationKey(request)!);
      }
      const result = await sandbox.runCommand({
        cmd: "bash",
        args: ["-lc", request.code],
        ...(cwd ? { cwd: cwd } : {}),
        env: mergeSandboxEnv(
          this.#config.envVars,
          request.envVars,
          request.principal,
        ),
        timeoutMs: request.timeoutSeconds * 1000,
      });

      return this.#adaptResult(result, request, startedAt);
    } finally {
      if (!persistent) {
        await sandbox.stop().then(
          (): void => endMeter?.(),
          (): void => {},
        );
      }
    }
  }

  async prewarm(request: {
    namespace?: string;
    reservationKey?: string;
  }): Promise<void> {
    if (!this.#persistent(request)) return;
    await this.#acquire({
      code: "",
      ...request,
      timeoutSeconds: 30,
      outputLimitBytes: 1024,
    });
  }

  async runBackground(request: SandboxRunRequest): Promise<SandboxJobHandle> {
    const ns = this.#requirePersistent(request);
    const sandbox = await this.#acquire(request);
    const workDir = this.#workDir(ns);
    await this.#ensureS3Mount(sandbox, request);
    await this.#shell(sandbox, `mkdir -p ${shellQuote(workDir)}`, { cwd: "/" });
    await this.#keepAlive(sandbox, request.timeoutSeconds);
    const jobId = request.jobId ?? generateJobId();
    await this.#runLifecycle(sandbox, ns);
    const script = launchScript(
      this.#jobsDir(ns),
      jobId,
      workDir,
      request.code,
      {
        maxConcurrentJobs: MAX_CONCURRENT_BACKGROUND_JOBS,
        ...(request.callback ? { callback: request.callback } : {}),
      },
    );
    const result = await sandbox.runCommand({
      cmd: "bash",
      args: ["-lc", script],
      env: {
        ...stringRecord(this.#config.envVars),
        ...callbackEnv(request.callback),
      },
      timeoutMs: request.timeoutSeconds * 1000,
    });
    if (result.exitCode !== 0) {
      throw new Error(
        await commandError(result, "failed to launch background job"),
      );
    }

    return { jobId: jobId, externalId: sandbox.name };
  }

  async jobStatus(request: SandboxJobRequest): Promise<SandboxJobStatus> {
    const { sandbox, jobsDir } = await this.#reserved(request);
    const status = await this.#shell(
      sandbox,
      statusScript(jobsDir, request.jobId),
    );
    // A polled job is activity: it holds the session open like a command does.
    await this.#keepAlive(sandbox, 0);

    return parseJobStatus(request.jobId, status);
  }

  async jobLogs(request: SandboxJobRequest): Promise<SandboxJobLogs> {
    const bytes = request.outputLimitBytes ?? 64 * 1024;
    const { sandbox, jobsDir } = await this.#reserved(request);
    const logs = truncateText(
      await this.#shell(sandbox, logsScript(jobsDir, request.jobId, bytes)),
      bytes,
    );

    return {
      jobId: request.jobId,
      logs: logs.value,
      truncated: logs.truncated,
    };
  }

  async stopJob(request: SandboxJobRequest): Promise<SandboxJobStatus> {
    const { sandbox, jobsDir } = await this.#reserved(request);
    await this.#shell(sandbox, stopScript(jobsDir, request.jobId));

    return parseJobStatus(
      request.jobId,
      await this.#shell(sandbox, statusScript(jobsDir, request.jobId)),
    );
  }

  async release(request: SandboxReleaseRequest): Promise<void> {
    const key = sandboxReservationKey(request);
    if (!key) return;
    const name =
      request.expectedExternalId ?? (await getSandboxExternalId("vercel", key));
    if (!name) return;
    try {
      const Sandbox = await this.#Sandbox();
      // The SDK sends no `resume` of its own, leaving the choice to the API. Say it
      // here: a teardown never needs a running VM, and booting one to delete it costs
      // compute and widens the window a concurrent acquire can slip into.
      const sandbox = await Sandbox.get({
        name: name,
        resume: false,
        ...vercelAuthOptions(this.#config),
      });
      await sandbox.delete();
    } catch (err) {
      if (!isSandboxGoneError(err)) throw err;
    }
    await deleteSandboxInstance(
      "vercel",
      key,
      this.#config.controlPlane?.accountId,
      name,
    ).catch(() => {});
  }

  /**
   * Captures the reserved sandbox as a Vercel snapshot, which any vercel
   * sandbox of the account can then boot through `config.snapshot`. Vercel stops
   * the sandbox to capture it; its next call resumes it.
   */
  async snapshot(
    request: SandboxReservationRef,
  ): Promise<SandboxSnapshotResult> {
    try {
      const { sandbox } = await this.#reserved(request);
      // Vercel expires a snapshot after 30 days by default; a pinned one must not.
      const snapshot = await sandbox.snapshot({ expiration: 0 });

      // The SDK answers a capture that failed with a failed snapshot, not a throw.
      if (snapshot.status !== "created") {
        throw new Error(
          `Vercel snapshot ${snapshot.snapshotId} ended ${snapshot.status}`,
        );
      }

      return { snapshotId: snapshot.snapshotId };
    } catch (err) {
      throw classifyVercelError(err);
    }
  }

  // Mounts the run's workspace prefix unless a live mount on fresh credentials
  // is already there. A resumed session lost its FUSE mount, and mount-s3 takes
  // credentials only at start, so either case replaces the daemon. The check
  // needs no credentials; STS is only called when a remount is due.
  async #ensureS3Mount(
    sandbox: VercelSandbox,
    request: SandboxRunRequest,
  ): Promise<void> {
    if (!this.#mountsWorkspace(request)) return;
    const mountPath = workspacePath(request, this.#workspaceRoot())!;
    const now = Math.floor(Date.now() / 1000);
    const check = await sandbox.runCommand({
      cmd: "bash",
      args: ["-lc", freshMountScript(mountPath, now)],
    });
    if (check.exitCode === 0) return;
    const mount = await resolveS3Mount(
      executorS3Context(this.#config, request),
    );
    if (!mount.credentials) {
      throw new Error(
        "vercel S3 workspace mounts need SANDBOX_MOUNT_ROLE_ARN in the harness runtime, or a workspace bucket with assumeRole or R2 auth",
      );
    }
    await this.#shell(sandbox, mountScript(mount, mountPath, now), {
      cwd: "/",
      env: {
        ...mount.credentials,
        ...(mount.region
          ? { AWS_REGION: mount.region, AWS_DEFAULT_REGION: mount.region }
          : {}),
      },
    });
  }

  #mountsWorkspace(request: { namespace?: string }): boolean {
    return (
      this.#config.options?.mountAwsS3Buckets === true && !!request.namespace
    );
  }

  // Extends the running session to last one idle window past a call of
  // `callSeconds`. Vercel refuses to extend past the plan's session cap; the
  // session then stops at the cap and the next call resumes it, so a refusal
  // only logs.
  async #keepAlive(sandbox: VercelSandbox, callSeconds: number): Promise<void> {
    const expiresAt = sandbox.expiresAt?.getTime();
    if (expiresAt === undefined) return;
    const { idleTimeoutSeconds } = resolveSandboxLifecycle(
      this.#config.lifecycle,
    );
    const shortMs =
      Date.now() + (idleTimeoutSeconds + callSeconds) * 1000 - expiresAt;
    if (shortMs <= 0) return;
    await sandbox.extendTimeout(Math.ceil(shortMs)).catch((err: unknown) => {
      logWarn("vercel sandbox session extension refused", {
        sandbox: sandbox.name,
        error: toErrorMessage(err),
      });
    });
  }

  // Checked at acquire, never on a timer, so the cap can never cut a running
  // command: the call that trips it boots a fresh sandbox.
  #outlivedMaxLifetime(sandbox: VercelSandbox): boolean {
    const { maxLifetimeSeconds } = resolveSandboxLifecycle(
      this.#config.lifecycle,
    );
    if (maxLifetimeSeconds === undefined) return false;

    return (
      Date.now() - sandbox.createdAt.getTime() >= maxLifetimeSeconds * 1000
    );
  }

  // The hosts a mounted workspace reaches, which a network that is not
  // allow-all must let through. Identity only: no STS call.
  #mountHosts(request: SandboxRunRequest): string[] {
    if (!this.#mountsWorkspace(request)) return [];

    return s3Hosts(
      resolveS3MountIdentity(executorS3Context(this.#config, request)),
    );
  }

  // A reserved sandbox whose config names another Secure Compute network moves
  // to it. Vercel applies the change on the next session, so the running one
  // keeps its network until the sandbox idles out.
  async #moveNetwork(sandbox: VercelSandbox): Promise<void> {
    const networkId = configString(this.#config.options?.networkId);
    if (sandbox.networkId === networkId) return;
    await sandbox.update({ networkId: networkId ?? null });
  }

  #persistent(request: {
    namespace?: string;
    reservationKey?: string;
  }): boolean {
    return this.#config.persistent === true && !!sandboxReservationKey(request);
  }

  #requirePersistent(request: {
    namespace?: string;
    reservationKey?: string;
  }): string {
    if (!this.#persistent(request)) {
      throw new Error(
        "background jobs require a persistent vercel sandbox reservation key",
      );
    }

    return sandboxReservationKey(request)!;
  }

  #workspaceRoot(): string {
    const options = isPlainObject(this.#config.options)
      ? this.#config.options
      : {};

    return (configString(options.workspaceRoot) ?? "/mnt/workspaces").replace(
      /\/+$/,
      "",
    );
  }

  #workDir(namespace: string): string {
    return `${this.#workspaceRoot()}/${namespace}`;
  }

  // Job and lifecycle markers stay on the sandbox's own disk beside the
  // workspace, never under its S3 mount: the mount has no append, and a marker
  // in the bucket would outlive the sandbox and skip onCreate on the next one.
  #jobsDir(namespace: string): string {
    return `${this.#workspaceRoot()}/.fp-jobs/${namespace}`;
  }

  async #acquire(request: SandboxRunRequest): Promise<VercelSandbox> {
    try {
      return await this.#acquireSandbox(request);
    } catch (err) {
      throw classifyVercelError(err);
    }
  }

  async #acquireSandbox(request: SandboxRunRequest): Promise<VercelSandbox> {
    const Sandbox = await this.#Sandbox();
    if (!this.#persistent(request)) {
      await assertSnapshotBootable(
        this.#config.controlPlane,
        this.#config.snapshot,
      );

      return Sandbox.create(
        vercelCreateOptions(
          this.#config,
          request,
          false,
          this.#mountHosts(request),
        ),
      );
    }

    const key = sandboxReservationKey(request)!;
    const storedName = await getSandboxExternalId("vercel", key);
    if (storedName) {
      try {
        const sandbox = await Sandbox.get({
          name: storedName,
          ...vercelAuthOptions(this.#config),
        });
        if (this.#outlivedMaxLifetime(sandbox)) {
          await this.release({ ...request, expectedExternalId: storedName });

          return await this.#acquireSandbox(request);
        }
        await this.#moveNetwork(sandbox);
        await saveSandboxInstance(
          "vercel",
          key,
          storedName,
          this.#config.controlPlane?.accountId,
        ).catch(() => {});
        await upsertSandboxInstance(
          this.#config.controlPlane,
          "vercel",
          key,
          storedName,
          request.metadata,
          { specs: vercelSpecs(sandbox) },
        );

        return sandbox;
      } catch (error) {
        // Recreate only when the sandbox is really gone; a transient error must
        // propagate or the still-live sandbox is orphaned at the provider. The
        // conditional delete keeps a row a concurrent call already re-claimed.
        if (!isSandboxGoneError(error)) throw error;
        await deleteSandboxInstance(
          "vercel",
          key,
          this.#config.controlPlane?.accountId,
          storedName,
        ).catch(() => {});
      }
    }

    // A fresh generation, so this machine is ours alone. `getOrCreate` on a name
    // derived from the key would hand back whatever machine already answers to
    // it, including one a sweeper has taken the row for and is about to delete.
    const name = vercelSandboxName(key);
    await assertSnapshotBootable(
      this.#config.controlPlane,
      this.#config.snapshot,
    );
    const sandbox = await Sandbox.create({
      ...vercelCreateOptions(
        this.#config,
        request,
        true,
        this.#mountHosts(request),
      ),
      name: name,
    });
    try {
      if (
        await claimSandboxInstance(
          "vercel",
          key,
          name,
          this.#config.controlPlane?.accountId,
        )
      ) {
        await upsertSandboxInstance(
          this.#config.controlPlane,
          "vercel",
          key,
          name,
          request.metadata,
          { specs: vercelSpecs(sandbox) },
        );

        return sandbox;
      }
    } catch (error) {
      // The claim may already have committed even when its caller rejects. Drop the
      // row while it still names this machine, then the machine itself; passing the
      // name keeps a concurrent winner's row and machine intact.
      await deleteSandboxInstance(
        "vercel",
        key,
        this.#config.controlPlane?.accountId,
        name,
      ).catch(() => {});
      await sandbox.delete().catch(() => {});
      throw error;
    }

    const winner = await getSandboxExternalId("vercel", key);
    if (!winner) {
      // The row went away between the refused claim and this read. Nothing maps
      // the key to this machine, so record it in the mirror and let the sweeper's
      // orphan adoption be what reaches it again.
      await upsertSandboxInstance(
        this.#config.controlPlane,
        "vercel",
        key,
        name,
        request.metadata,
        { specs: vercelSpecs(sandbox) },
      );

      return sandbox;
    }
    await sandbox.delete().catch(() => {});

    return Sandbox.get({
      name: winner,
      ...vercelAuthOptions(this.#config),
    });
  }

  // The reserved sandbox, for background jobs and the Snapshot action.
  async #reserved(
    request: SandboxReservationRef,
  ): Promise<{ sandbox: VercelSandbox; jobsDir: string }> {
    const key = sandboxReservationKey(request);
    if (!key)
      throw new Error("a persistent sandbox reservation key is required");
    const name = await getSandboxExternalId("vercel", key);
    if (!name)
      throw new Error("no reserved vercel sandbox for this reservation");
    const Sandbox = await this.#Sandbox();
    const sandbox = await Sandbox.get({
      name: name,
      ...vercelAuthOptions(this.#config),
    });

    return { sandbox: sandbox, jobsDir: this.#jobsDir(key) };
  }

  async #shell(
    sandbox: VercelSandbox,
    code: string,
    opts: { cwd?: string; env?: Record<string, string> } = {},
  ): Promise<string> {
    const result = await sandbox.runCommand({
      cmd: "bash",
      args: ["-lc", code],
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      env: { ...stringRecord(this.#config.envVars), ...opts.env },
    });
    if (result.exitCode !== 0) {
      throw new Error(
        await commandError(result, "vercel sandbox setup command failed"),
      );
    }

    return await result.stdout();
  }

  async #runLifecycle(sandbox: VercelSandbox, key: string): Promise<void> {
    if (!this.#config.onCreate?.length && !this.#config.onResume?.length)
      return;
    const workDir = this.#workDir(key);
    const marker = `${this.#jobsDir(key)}/.fp-lifecycle-created`;
    const createCommands = this.#config.onCreate ?? [];
    const resumeCommands = this.#config.onResume ?? [];
    const script = [
      "set -e",
      `mkdir -p ${shellQuote(workDir)} ${shellQuote(this.#jobsDir(key))}`,
      `cd ${shellQuote(workDir)}`,
      `if [ ! -f ${shellQuote(marker)} ]; then`,
      ...createCommands.map((cmd) => `  ${cmd}`),
      `  touch ${shellQuote(marker)}`,
      "else",
      ...resumeCommands.map((cmd) => `  ${cmd}`),
      "fi",
    ].join("\n");
    await this.#shell(sandbox, script, { cwd: "/" });
  }

  async #adaptResult(
    result: CommandFinished,
    request: SandboxRunRequest,
    startedAt: number,
  ): Promise<SandboxRunResult> {
    const [rawStdout, rawStderr] = await Promise.all([
      result.stdout(),
      result.stderr(),
    ]);
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

// The @vercel/sandbox SDK surfaces auth failures as "Status code 403 is not ok",
// followed by the API's reason when it gives one. Keep that reason (a Secure
// Compute network the team cannot use answers 401 too); a bare status means
// the token, so say what to check.
export function classifyVercelError(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);
  const numericStatus = [
    (err as { status?: unknown })?.status,
    (err as { statusCode?: unknown })?.statusCode,
    (err as { response?: { status?: unknown } })?.response?.status,
  ].find((value): value is number => typeof value === "number");
  // Fall back to the SDK's documented auth-failure phrasing ("Status code 403 is not
  // ok") rather than scanning for any 401/403 substring, which could match unrelated
  // numbers (ids, timestamps) in some other error message.
  const matched = /status code (401|403)\b/i.exec(message);
  const status = numericStatus ?? (matched ? Number(matched[1]) : undefined);
  if (status === 401 || status === 403) {
    const reason = /status code \d+ is not ok:\s*(.+)/is.exec(message)?.[1];

    return new Error(
      `Vercel Sandbox rejected the request (HTTP ${status}): ` +
        (reason ??
          "the VERCEL_TOKEN is invalid or lacks access to the configured team/project. " +
            "Verify VERCEL_TOKEN, VERCEL_TEAM_ID, and VERCEL_PROJECT_ID."),
    );
  }

  return err instanceof Error ? err : new Error(message);
}

async function commandError(
  result: CommandFinished,
  fallback: string,
): Promise<string> {
  const [stderr, stdout] = await Promise.all([
    result.stderr(),
    result.stdout(),
  ]);

  return [stderr, stdout].filter(Boolean).join("\n") || fallback;
}

function vercelAuthOptions(config: SandboxExecutorConfig): {
  token: string;
  teamId: string;
  projectId: string;
} {
  const options = isPlainObject(config.options) ? config.options : {};
  const token = configString(options.token) ?? optionalEnv("VERCEL_TOKEN");
  const teamId = configString(options.teamId) ?? optionalEnv("VERCEL_TEAM_ID");
  const projectId =
    configString(options.projectId) ?? optionalEnv("VERCEL_PROJECT_ID");
  const missing = Object.entries({
    token: token,
    teamId: teamId,
    projectId: projectId,
  })
    .filter(([, value]) => !value)
    .map(([key]) => key);
  if (missing.length > 0) {
    throw new Error(
      `vercel sandbox auth is missing ${missing.join(", ")}; set config.options.{token,teamId,projectId} or VERCEL_TOKEN/VERCEL_TEAM_ID/VERCEL_PROJECT_ID`,
    );
  }

  return { token: token!, teamId: teamId!, projectId: projectId! };
}

function vercelCreateOptions(
  config: SandboxExecutorConfig,
  request: { envVars?: Record<string, string>; timeoutSeconds: number },
  persistent: boolean,
  mountHosts: string[],
): VercelCreateOptions {
  const lifecycle = resolveSandboxLifecycle(config.lifecycle);
  const snapshot = config.snapshot;
  const source = snapshot?.startsWith(SNAPSHOT_ID_PREFIX)
    ? { source: { type: "snapshot" as const, snapshotId: snapshot } }
    : snapshot
      ? { image: snapshot }
      : {};
  const networkId = configString(config.options?.networkId);

  return {
    ...vercelAuthOptions(config),
    ...source,
    ...(networkId ? { networkId: networkId } : {}),
    persistent: persistent,
    timeout:
      (persistent
        ? lifecycle.idleTimeoutSeconds
        : request.timeoutSeconds + EPHEMERAL_SETUP_SECONDS) * 1000,
    networkPolicy: vercelNetworkPolicy(config, mountHosts),
    // No run identity here: a sandbox outlives the run that created it, and
    // every exec lays its own over this env.
    env: mergeSandboxEnv(config.envVars, request.envVars),
    tags: { app: "broods", provider: "vercel" },
  };
}

// A mounted workspace's S3 hosts join whatever the config allows, the way a
// lambda sandbox always reaches its managed bucket.
function vercelNetworkPolicy(
  config: SandboxExecutorConfig,
  mountHosts: string[],
): NetworkPolicy {
  const network = config.network ?? { mode: "deny-all" as const };
  if (network.mode === "allow-all") return "allow-all";
  if (network.mode === "deny-all" && mountHosts.length === 0) return "deny-all";
  const allow = [...(network.allowDomains ?? []), ...mountHosts];

  return {
    ...(allow.length ? { allow: allow } : {}),
    ...(network.allowCidrs?.length
      ? { subnets: { allow: network.allowCidrs } }
      : {}),
  };
}

// A prefix that reads back to the reservation key, plus a generation nothing can
// derive from that key. The generation is what makes `externalId` identify a machine,
// so the conditional writes guarding a reservation refuse a machine some other caller
// created under the same key.
function vercelSandboxName(reservationKey: string): string {
  return `${sandboxNamePrefix(reservationKey)}-${randomUUID().slice(0, GENERATION_LENGTH)}`;
}

// The vCPUs and memory Vercel gave the sandbox. Vercel reports no disk size, and
// an older session may report neither, which leaves the config's size in place.
function vercelSpecs(sandbox: VercelSandbox): SandboxSpecs | undefined {
  const { vcpus, memory } = sandbox;
  if (vcpus === undefined || memory === undefined) return undefined;

  return { vcpu: vcpus, memoryMb: memory };
}

// Installs mount-s3 when the image lacks it, then replaces any stale mount with
// one on the credentials in this command's env. One lock serializes it: a
// model's parallel tool calls on a fresh sandbox would otherwise both run apt
// and both mount, and the one that waits finds the mount fresh and skips. They stay out of the sandbox
// env and every later command's, but the daemon holds them and the agent has
// sudo, which is why they are scoped to the prefix and last an hour.
function mountScript(
  mount: ResolvedS3Mount,
  mountPath: string,
  now: number,
): string {
  const quotedPath = shellQuote(mountPath);
  const mountArgs = [
    "--allow-delete",
    "--allow-overwrite",
    "--allow-other",
    ...(mount.prefix ? ["--prefix", mount.prefix] : []),
    ...(mount.region ? ["--region", mount.region] : []),
    ...(mount.endpoint ? ["--endpoint-url", mount.endpoint] : []),
    mount.bucket,
    mountPath,
  ]
    .map(shellQuote)
    .join(" ");

  return [
    "set -e",
    `exec 9>${MOUNT_LOCK}`,
    "flock 9",
    "if ! command -v mount-s3 >/dev/null; then",
    '  arch="$(dpkg --print-architecture | sed s/amd64/x86_64/)"',
    `  curl -fsSL -o /tmp/mount-s3.deb "${MOUNT_S3_PACKAGE}" || { echo "mount-s3 is not installed and could not be fetched; boot a snapshot that has it, or allow egress to s3.amazonaws.com and the Ubuntu mirrors" >&2; exit 1; }`,
    "  sudo apt-get update -qq",
    "  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq /tmp/mount-s3.deb",
    "  rm -f /tmp/mount-s3.deb",
    "fi",
    `if ! { ${freshMountScript(mountPath, now)}; }; then`,
    `  sudo umount -l ${quotedPath} 2>/dev/null || true`,
    `  sudo mkdir -p ${quotedPath}`,
    `  sudo chown "$(id -u)":"$(id -g)" ${quotedPath}`,
    `  sudo -E mount-s3 --uid "$(id -u)" --gid "$(id -g)" ${mountArgs}`,
    `  echo ${now} | sudo tee "$stamp_file" >/dev/null`,
    "fi",
  ].join("\n");
}

// The hosts mount-s3 talks to: the bucket's virtual host and the regional
// endpoint on AWS, or the endpoint and its bucket subdomain elsewhere (R2).
function s3Hosts(mount: S3MountIdentity): string[] {
  if (mount.endpoint) {
    const host = new URL(mount.endpoint).hostname;

    return [host, `${mount.bucket}.${host}`];
  }
  const endpoint = mount.region
    ? `s3.${mount.region}.amazonaws.com`
    : "s3.amazonaws.com";

  return [endpoint, `${mount.bucket}.${endpoint}`];
}
