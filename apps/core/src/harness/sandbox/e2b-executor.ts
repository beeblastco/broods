/**
 * E2B-backed sandbox executor.
 * Keep E2B SDK adaptation here. Commands run in E2B's native sandbox filesystem.
 * Persistent mode reserves one sandbox per key, reconnecting by stored id (E2B
 * auto-pauses it on idle and connect resumes it).
 */

import type { Sandbox } from "e2b";
import { Buffer } from "node:buffer";
import { upsertSandboxInstance } from "../../shared/convex/sandbox-instances.ts";
import { optionalEnv } from "../../shared/env.ts";
import { isPlainObject } from "../../shared/object.ts";
import { resolveSandboxLifecycle } from "../../shared/sandbox.ts";
import type { SandboxSpecs } from "../../shared/sandbox-sizes.ts";
import {
  claimSandboxInstance,
  deleteSandboxInstance,
  getSandboxExternalId,
  saveSandboxInstance,
} from "./instance-store.ts";
import { callbackEnv, callbackSnippet, generateJobId } from "./jobs.ts";
import type {
  SandboxExecutor,
  SandboxExecutorConfig,
  SandboxJobHandle,
  SandboxReleaseRequest,
  SandboxRunRequest,
  SandboxRunResult,
} from "./types.ts";
import {
  configString,
  isSandboxGoneError,
  mergeSandboxEnv,
  meterEphemeralSandbox,
  sandboxReservationKey,
  shellQuote,
  truncateText,
} from "./utils.ts";

// How long a size read may take before the size is left unknown.
const SPECS_READ_TIMEOUT_MS = 3_000;

// What E2B reported for each reserved sandbox. Its template fixes the size, so
// one read covers every reconnect; release drops the entry.
const RESERVED_SPECS = new Map<string, SandboxSpecs>();

export class E2BSandboxExecutor implements SandboxExecutor {
  readonly #config: SandboxExecutorConfig;

  constructor(config: SandboxExecutorConfig) {
    this.#config = config;
  }

  async run(request: SandboxRunRequest): Promise<SandboxRunResult> {
    const startedAt = Date.now();
    const persistent = this.#persistent(request);
    const sandbox = await this.#acquire(request);
    const controlPlane = this.#config.controlPlane;
    // Only a metered call reads the size, since its row is the one place it
    // shows, and the read runs beside the command rather than ahead of it.
    const endMeter = persistent
      ? undefined
      : meterEphemeralSandbox(
          controlPlane,
          "e2b",
          sandbox.sandboxId,
          request.metadata,
          controlPlane && !controlPlane.ownCredentials
            ? e2bSpecs(sandbox)
            : undefined,
        );

    try {
      const result = await sandbox.commands.run(request.code, {
        timeoutMs: request.timeoutSeconds * 1000,
        envs: mergeSandboxEnv(
          this.#config.envVars,
          request.envVars,
          request.principal,
        ),
      });
      const stdout = truncateText(
        result.stdout ?? "",
        request.outputLimitBytes,
      );
      const stderr = truncateText(
        [result.stderr, result.error].filter(Boolean).join("\n"),
        request.outputLimitBytes,
      );

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
      if (!persistent) {
        await sandbox.kill();
        endMeter?.();
      }
    }
  }

  async runBackground(request: SandboxRunRequest): Promise<SandboxJobHandle> {
    this.#requirePersistent(request);
    const sandbox = await this.#acquire(request);
    const jobId = request.jobId ?? generateJobId();
    const handle = await sandbox.commands.run(
      e2bBackgroundCommand(request, jobId),
      {
        background: true,
        timeoutMs: request.timeoutSeconds * 1000,
        envs: {
          ...mergeSandboxEnv(this.#config.envVars, request.envVars),
          ...callbackEnv(request.callback),
        },
      },
    );
    await handle.disconnect().catch(() => {});

    return { jobId: jobId, externalId: sandbox.sandboxId };
  }

  async release(request: SandboxReleaseRequest): Promise<void> {
    const key = sandboxReservationKey(request);
    if (!key) return;
    const externalId =
      request.expectedExternalId ?? (await getSandboxExternalId("e2b", key));
    if (!externalId) return;
    const Sandbox = await e2bSandboxApi();
    try {
      await Sandbox.kill(externalId, e2bApiOptions(this.#config));
    } catch (err) {
      // Already gone => safe to forget. Wrong creds / transient => propagate so a
      // caller iterating multiple configs can try the next one.
      if (!isSandboxGoneError(err)) throw err;
    }
    await deleteSandboxInstance(
      "e2b",
      key,
      this.#config.controlPlane?.accountId,
      externalId,
    ).catch(() => {});
    RESERVED_SPECS.delete(externalId);
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
  }): void {
    if (!this.#persistent(request)) {
      throw new Error(
        "background jobs require a persistent e2b sandbox reservation key",
      );
    }
  }

  async #acquire(request: SandboxRunRequest): Promise<Sandbox> {
    const Sandbox = await e2bSandboxApi();
    if (!this.#persistent(request)) {
      return Sandbox.create(e2bCreateOptions(this.#config, false));
    }
    const ns = sandboxReservationKey(request)!;
    const externalId = await getSandboxExternalId("e2b", ns);
    if (externalId) {
      try {
        const sandbox = await Sandbox.connect(
          externalId,
          e2bApiOptions(this.#config),
        );
        await saveSandboxInstance(
          "e2b",
          ns,
          externalId,
          this.#config.controlPlane?.accountId,
        ).catch(() => {});
        await upsertSandboxInstance(
          this.#config.controlPlane,
          "e2b",
          ns,
          externalId,
          request.metadata,
          { specs: await reservedSpecs(sandbox) },
        );

        return sandbox;
      } catch (error) {
        // Recreate only when the sandbox is really gone; a transient error must
        // propagate or the still-live sandbox is orphaned at the provider. The
        // conditional delete keeps a row a concurrent call already re-claimed.
        if (!isSandboxGoneError(error)) throw error;
        await deleteSandboxInstance(
          "e2b",
          ns,
          this.#config.controlPlane?.accountId,
          externalId,
        ).catch(() => {});
      }
    }
    const created = await Sandbox.create(e2bCreateOptions(this.#config, true));
    try {
      if (
        await claimSandboxInstance(
          "e2b",
          ns,
          created.sandboxId,
          this.#config.controlPlane?.accountId,
        )
      ) {
        await upsertSandboxInstance(
          this.#config.controlPlane,
          "e2b",
          ns,
          created.sandboxId,
          request.metadata,
          { specs: await reservedSpecs(created) },
        );

        return created;
      }
    } catch (error) {
      // The claim may already have committed even when its caller rejects. Tear
      // down both sides conditionally so a failed acquisition cannot leak the
      // newly created sandbox or erase a concurrent winner's reservation.
      await Promise.allSettled([
        Sandbox.kill(created.sandboxId, e2bApiOptions(this.#config)),
        deleteSandboxInstance(
          "e2b",
          ns,
          this.#config.controlPlane?.accountId,
          created.sandboxId,
        ),
      ]);
      throw error;
    }
    // Lost a concurrent create race: the winner's sandbox is the one to use.
    const winner = await getSandboxExternalId("e2b", ns);
    await Sandbox.kill(created.sandboxId, e2bApiOptions(this.#config)).catch(
      () => {},
    );
    if (!winner)
      throw new Error("failed to reserve e2b sandbox (lost create race)");

    return Sandbox.connect(winner, e2bApiOptions(this.#config));
  }
}

function e2bApiOptions(config: SandboxExecutorConfig): Record<string, unknown> {
  const options = isPlainObject(config.options) ? config.options : {};
  const apiKey = configString(options.apiKey) ?? optionalEnv("E2B_API_KEY");

  return {
    ...(apiKey ? { apiKey: apiKey } : {}),
    timeoutMs:
      resolveSandboxLifecycle(config.lifecycle).idleTimeoutSeconds * 1000,
  };
}

function e2bBackgroundCommand(
  request: SandboxRunRequest,
  jobId: string,
): string {
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

function e2bCreateOptions(
  config: SandboxExecutorConfig,
  persistent: boolean,
): Record<string, unknown> {
  const options = isPlainObject(config.options) ? config.options : {};
  const apiKey = configString(options.apiKey) ?? optionalEnv("E2B_API_KEY");
  const template =
    configString(options.template) ?? configString(options.templateId);

  return {
    ...(apiKey ? { apiKey: apiKey } : {}),
    ...(template ? { template: template } : {}),
    // Auto-pause on idle (instead of kill) so a reserved sandbox can be resumed.
    ...(persistent
      ? {
          timeoutMs:
            resolveSandboxLifecycle(config.lifecycle).idleTimeoutSeconds * 1000,
          lifecycle: { onTimeout: "pause" },
        }
      : {}),
  };
}

// e2b's bundle require()s chalk while the pi harness imports that same chalk as
// ESM, and one eager graph holding both is a race. Load it only when e2b is used.
async function e2bSandboxApi(): Promise<typeof import("e2b").Sandbox> {
  const { Sandbox } = await import("e2b");

  return Sandbox;
}

// The vCPUs and memory E2B gave the sandbox. E2B reports no disk size. A slow or
// failed read leaves the size unknown rather than holding up or failing the call.
async function e2bSpecs(sandbox: Sandbox): Promise<SandboxSpecs | undefined> {
  try {
    const info = await sandbox.getInfo({
      requestTimeoutMs: SPECS_READ_TIMEOUT_MS,
    });

    return { vcpu: info.cpuCount, memoryMb: info.memoryMB };
  } catch {
    return undefined;
  }
}

// A reserved sandbox's size, read from E2B once and then kept.
async function reservedSpecs(
  sandbox: Sandbox,
): Promise<SandboxSpecs | undefined> {
  const known = RESERVED_SPECS.get(sandbox.sandboxId);
  if (known) return known;
  const specs = await e2bSpecs(sandbox);
  if (specs) RESERVED_SPECS.set(sandbox.sandboxId, specs);

  return specs;
}
