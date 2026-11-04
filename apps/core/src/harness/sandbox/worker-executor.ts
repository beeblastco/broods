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
  PlatformWorkerError,
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
const WORKER_OVERHEAD_MS = 15_000;
// So two commands never start from the same stored files; the Worker's conditional write backs it.
const runsByReservation = new Map<string, Promise<unknown>>();

const statusResult = z.object({ exists: z.boolean() });

export function workerConnection(): PlatformWorkerConnection {
  return platformWorkerConnection(
    "CLOUDFLARE_WORKER_URL",
    "CLOUDFLARE_WORKER_API_KEY",
    "worker",
  );
}

export class WorkerSandboxExecutor implements SandboxExecutor {
  readonly #config: SandboxExecutorConfig;

  constructor(config: SandboxExecutorConfig) {
    if (config.storage)
      throw new Error("the worker sandbox provider cannot mount workspaces");
    this.#config = config;
  }

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

      return execRunResult(request, result, "worker", startedAt);
    }
    const result = await serializedByReservation(
      reserved,
      (): Promise<SandboxExecResponse> => this.#exec(reserved, request, true),
    );
    this.#mirror(key, reserved, request.metadata);

    return execRunResult(request, result, "worker", startedAt);
  }

  // Nothing runs between calls, so a reservation with stored files is suspended, not running.
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

  async #exec(
    id: string,
    request: SandboxRunRequest,
    persist: boolean,
  ): Promise<SandboxExecResponse> {
    const timeoutMs = Math.min(request.timeoutSeconds * 1000, MAX_TIMEOUT_MS);
    const startedAt = Date.now();
    try {
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
          outputLimitBytes: Math.min(
            request.outputLimitBytes,
            MAX_OUTPUT_BYTES,
          ),
          enableInternet: this.#config.network?.mode === "allow-all",
          persist: persist,
        },
        timeoutMs + WORKER_OVERHEAD_MS,
      );
      const result = parseExecResponse(await response.text(), LABEL);
      this.#meter(result.duration_ms, request.metadata);

      return result;
    } catch (error) {
      // Any answer, a 409 included, means the command ran; an unreached Worker ran nothing.
      if (error instanceof PlatformWorkerError)
        this.#meter(Date.now() - startedAt, request.metadata);
      throw error;
    }
  }

  // The platform pays for every isolate, so only a config with no account goes unmetered.
  #meter(durationMs: number, metadata: SandboxRunMetadata | undefined): void {
    const plane = this.#config.controlPlane;
    if (!plane) return;
    recordUsage(
      plane.accountId,
      { workerMs: durationMs, workerRequests: 1 },
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
