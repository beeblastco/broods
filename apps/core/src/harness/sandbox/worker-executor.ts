/**
 * Isolate sandbox executor: bash in a V8 isolate on Cloudflare Workers, no
 * container. Commands go over authenticated HTTP to the Worker in
 * `apps/cloudflare-worker`, which runs each in a Dynamic Worker per sandbox
 * id and keeps a reserved sandbox's files in R2 between calls. Nothing runs
 * between commands, so a persistent sandbox is its stored files, not a warm
 * machine. Reservation bookkeeping stays here.
 */

import { z } from "zod";
import {
  MAX_OUTPUT_BYTES,
  MAX_TIMEOUT_MS,
} from "../../../../cloudflare-worker/src/limits.ts";
import { upsertSandboxInstance } from "../../shared/convex/sandbox-instances.ts";
import type { SandboxExecResponse } from "../../shared/domain/sandbox-config.ts";
import type { SandboxRunMetadata } from "../../shared/sandbox-sizes.ts";
import { recordUsage } from "../plan-limits.ts";
import { getSandboxExternalId } from "./instance-store.ts";
import {
  callPlatformWorker,
  platformWorkerConnection,
  releasePlatformSandbox,
  reservePlatformSandbox,
  type PlatformWorkerConnection,
} from "./platform-worker.ts";
import type {
  SandboxExecutor,
  SandboxExecutorConfig,
  SandboxInstanceInfo,
  SandboxReleaseRequest,
  SandboxReservationRef,
  SandboxRunRequest,
  SandboxRunResult,
} from "./types.ts";
import {
  execRunResult,
  mergeSandboxEnv,
  parseExecResponse,
  queueMirrorWrite,
  requiredWorkspacePath,
  sandboxReservationKey,
} from "./utils.ts";

const LABEL = "cloudflare v8 worker";
// Headroom over the command timeout for the Worker to load the isolate and
// move the stored files.
const WORKER_OVERHEAD_MS = 15_000;
// Commands in flight per reserved sandbox, so two never start from the same
// stored files; the Worker's conditional write stays as the guard behind it.
const runsByReservation = new Map<string, Promise<unknown>>();

const statusResult = z.object({ exists: z.boolean() });

/** The platform Worker from core's env; every executor call uses it. */
export function workerConnection(): PlatformWorkerConnection {
  return platformWorkerConnection(
    "CLOUDFLARE_WORKER_URL",
    "CLOUDFLARE_WORKER_API_KEY",
    "worker",
  );
}

/** Runs bash in a Cloudflare V8 Worker; picked by `providerExecutor` for `provider: "worker"`. */
export class WorkerSandboxExecutor implements SandboxExecutor {
  readonly #config: SandboxExecutorConfig;

  constructor(config: SandboxExecutorConfig) {
    if (config.storage)
      throw new Error("the worker sandbox provider cannot mount workspaces");
    this.#config = config;
  }

  /**
   * Runs one command. A persistent config reuses its reservation's stored
   * files, one command at a time; anything else runs on an empty disk that
   * is gone afterwards, so there is nothing to destroy and no instance row
   * to keep for it.
   */
  async run(request: SandboxRunRequest): Promise<SandboxRunResult> {
    const startedAt = Date.now();
    const key = sandboxReservationKey(request);
    const reserved =
      this.#config.persistent === true && key !== undefined
        ? await reservePlatformSandbox(
            "worker",
            this.#config.controlPlane?.accountId,
            key,
          )
        : undefined;
    if (reserved === undefined || key === undefined) {
      const result = await this.#exec(
        `fp-e-${crypto.randomUUID()}`,
        request,
        false,
      );
      this.#meter(result.duration_ms, request.metadata);

      return execRunResult(request, result, "worker", startedAt);
    }
    const result = await serializedByReservation(
      reserved,
      (): Promise<SandboxExecResponse> => this.#exec(reserved, request, true),
    );
    this.#meter(result.duration_ms, request.metadata);
    this.#mirror(key, reserved, request.metadata);

    return execRunResult(request, result, "worker", startedAt);
  }

  /** A reservation whose files are stored: kept, not running, since nothing runs between calls. */
  async getInstanceInfo(
    request: SandboxReservationRef,
  ): Promise<SandboxInstanceInfo | null> {
    const key = sandboxReservationKey(request);
    const id = key ? await getSandboxExternalId("worker", key) : null;
    if (!id) return null;
    const response = await callPlatformWorker(
      workerConnection(),
      LABEL,
      `/v1/sandboxes/${id}`,
      "GET",
    );
    const { exists } = statusResult.parse(await response.json());

    return exists ? { externalId: id, state: "suspended" } : null;
  }

  /** Drops a reservation's stored files and the reservation; cleanup and terminate call it. */
  async release(request: SandboxReleaseRequest): Promise<void> {
    await releasePlatformSandbox(
      "worker",
      this.#config.controlPlane?.accountId,
      request,
      async (id): Promise<void> => {
        await callPlatformWorker(
          workerConnection(),
          LABEL,
          `/v1/sandboxes/${id}`,
          "DELETE",
        );
      },
    );
  }

  // One command on the Worker, clamped to its limits.
  async #exec(
    id: string,
    request: SandboxRunRequest,
    persist: boolean,
  ): Promise<SandboxExecResponse> {
    const timeoutMs = Math.min(request.timeoutSeconds * 1000, MAX_TIMEOUT_MS);
    const response = await callPlatformWorker(
      workerConnection(),
      LABEL,
      `/v1/sandboxes/${id}/exec`,
      "POST",
      {
        script: request.code,
        args: request.args ?? [],
        cwd: requiredWorkspacePath(request, "/workspace"),
        env: mergeSandboxEnv(
          this.#config.envVars,
          request.envVars,
          request.principal,
        ),
        timeoutMs: timeoutMs,
        outputLimitBytes: Math.min(request.outputLimitBytes, MAX_OUTPUT_BYTES),
        enableInternet: this.#config.network?.mode === "allow-all",
        persist: persist,
      },
      timeoutMs + WORKER_OVERHEAD_MS,
    );

    return parseExecResponse(await response.text(), LABEL);
  }

  // Nothing runs between commands, so each one is metered as it ends: its
  // time on the Worker, plus the request. The platform always pays for an
  // isolate, so only a config with no account goes unmetered. The project is
  // the config's, else the one the run's agent or workspace belongs to.
  #meter(durationMs: number, metadata: SandboxRunMetadata | undefined): void {
    const plane = this.#config.controlPlane;
    if (!plane) return;
    recordUsage(
      plane.accountId,
      { isolateMs: durationMs, isolateRequests: 1 },
      {
        ...(plane.projectId !== undefined
          ? { projectId: plane.projectId }
          : {}),
        ...(metadata?.agentId !== undefined
          ? { agentId: metadata.agentId }
          : {}),
        ...(metadata?.workspaceId !== undefined
          ? { workspaceId: metadata.workspaceId }
          : {}),
      },
    );
  }

  // Mirrors a reservation into Convex once a command answered, so a Worker
  // that refused is never billed. Recoverable, so it never holds up the command.
  #mirror(
    key: string,
    id: string,
    metadata: SandboxRunRequest["metadata"],
  ): void {
    void queueMirrorWrite(id, (): Promise<void> =>
      upsertSandboxInstance(
        this.#config.controlPlane,
        "worker",
        key,
        id,
        metadata,
      ),
    );
  }
}

// Runs `command` after every earlier command on the same reservation, whether
// that one succeeded or failed, so each starts from the files the last left.
function serializedByReservation<T>(
  id: string,
  command: () => Promise<T>,
): Promise<T> {
  const previous = runsByReservation.get(id) ?? Promise.resolve();
  const run = previous.then(command, command);
  const settled = run.then(
    (): void => {},
    (): void => {},
  );
  runsByReservation.set(id, settled);
  void settled.then((): void => {
    if (runsByReservation.get(id) === settled) runsByReservation.delete(id);
  });

  return run;
}
