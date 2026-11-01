import type { Sandbox } from "e2b";
import { Buffer } from "node:buffer";
import {
  setSandboxInstanceSpecs,
  upsertSandboxInstance,
} from "../../shared/convex/sandbox-instances.ts";
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
  sandboxReservationKey,
  shellQuote,
  truncateText,
} from "./utils.ts";

const SPECS_READ_TIMEOUT_MS = 3_000;

export class E2BSandboxExecutor implements SandboxExecutor {
  readonly #config: SandboxExecutorConfig;

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
          "e2b",
          sandbox.sandboxId,
          request.metadata,
          () => e2bSpecs(sandbox),
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
      // Only a gone sandbox is forgotten; wrong creds throw so the caller tries its next config.
      if (!isSandboxGoneError(err)) throw err;
    }
    await deleteSandboxInstance(
      "e2b",
      key,
      this.#config.controlPlane?.accountId,
      externalId,
    ).catch(() => {});
  }

  async snapshot(
    request: SandboxReservationRef,
  ): Promise<SandboxSnapshotResult> {
    const key = sandboxReservationKey(request);
    const externalId = key ? await getSandboxExternalId("e2b", key) : null;
    if (!externalId) {
      throw new Error("no reserved e2b sandbox to snapshot for this sandbox");
    }
    const Sandbox = await e2bSandboxApi();
    const snapshot = await Sandbox.createSnapshot(
      externalId,
      e2bApiOptions(this.#config),
    );

    return { snapshotId: snapshot.snapshotId };
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
      await assertSnapshotBootable(
        this.#config.controlPlane,
        this.#config.snapshot,
      );

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
        );

        return sandbox;
      } catch (error) {
        // Recreate only when really gone: a transient error would orphan the live sandbox.
        if (!isSandboxGoneError(error)) throw error;
        await deleteSandboxInstance(
          "e2b",
          ns,
          this.#config.controlPlane?.accountId,
          externalId,
        ).catch(() => {});
      }
    }
    await assertSnapshotBootable(
      this.#config.controlPlane,
      this.#config.snapshot,
    );
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
        );
        // Read once, off the acquire path; reconnects send no size and the row keeps this one.
        const accountId = this.#config.controlPlane?.accountId;
        if (accountId) {
          void e2bSpecs(created).then((specs): void => {
            if (specs) {
              void setSandboxInstanceSpecs(
                accountId,
                ns,
                created.sandboxId,
                specs,
              );
            }
          });
        }

        return created;
      }
    } catch (error) {
      // The claim may have committed though it rejected: undo both sides, conditionally.
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

  return {
    ...(apiKey ? { apiKey: apiKey } : {}),
    ...(config.snapshot ? { template: config.snapshot } : {}),
    ...(persistent
      ? {
          timeoutMs:
            resolveSandboxLifecycle(config.lifecycle).idleTimeoutSeconds * 1000,
          lifecycle: { onTimeout: "pause" },
        }
      : {}),
  };
}

// Lazy: e2b require()s the chalk the pi harness imports as ESM; one eager graph with both races.
async function e2bSandboxApi(): Promise<typeof import("e2b").Sandbox> {
  const { Sandbox } = await import("e2b");

  return Sandbox;
}

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
