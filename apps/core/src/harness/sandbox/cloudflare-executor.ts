// A Container that sleeps loses its disk: persistent means one warm machine, not durable files.

import { z } from "zod";
import {
  MAX_OUTPUT_BYTES,
  MAX_TIMEOUT_MS,
} from "../../../../cloudflare-sandbox/src/limits.ts";
import { upsertSandboxInstance } from "../../shared/convex/sandbox-instances.ts";
import type { SandboxExecResponse } from "../../shared/domain/sandbox-config.ts";
import { toErrorMessage } from "../../shared/errors.ts";
import { waitUntil } from "../../shared/in-flight.ts";
import { logWarn } from "../../shared/log.ts";
import { resolveSandboxLifecycle } from "../../shared/sandbox.ts";
import { CLOUDFLARE_INSTANCE_TYPES } from "../../shared/sandbox-sizes.ts";
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
  configuredSandboxSpecs,
  execRunResult,
  mergeSandboxEnv,
  meterEphemeralSandbox,
  parseExecResponse,
  queueMirrorWrite,
  requiredWorkspacePath,
  sandboxReservationKey,
} from "./utils.ts";

const RUN_IN_CWD =
  'mkdir -p -- "$1" && cd -- "$1" && exec bash -lc "$2" bash "${@:3}"';
const BRIDGE_OVERHEAD_MS = 60_000;
// How long an ephemeral Container outlives its command if its DELETE fails.
const EPHEMERAL_IDLE_GRACE_SECONDS = 60;
const LABEL = "cloudflare sandbox bridge";

const statusResult = z.object({ running: z.boolean() });

export function cloudflareConnection(): PlatformWorkerConnection {
  return platformWorkerConnection(
    "CLOUDFLARE_SANDBOX_URL",
    "CLOUDFLARE_SANDBOX_API_KEY",
    "cloudflare",
  );
}

export class CloudflareSandboxExecutor implements SandboxExecutor {
  readonly #config: SandboxExecutorConfig;

  constructor(config: SandboxExecutorConfig) {
    if (config.storage)
      throw new Error(
        "the cloudflare sandbox provider cannot mount workspaces",
      );
    this.#config = config;
  }

  async run(request: SandboxRunRequest): Promise<SandboxRunResult> {
    const startedAt = Date.now();
    const key = sandboxReservationKey(request);
    const controlPlane = this.#config.controlPlane;
    const reserved =
      this.#config.persistent === true && key !== undefined
        ? await reservePlatformSandbox(
            "cloudflare",
            controlPlane?.accountId,
            key,
          )
        : undefined;
    const id = reserved ?? `fp-e-${crypto.randomUUID()}`;
    const endMeter = reserved
      ? undefined
      : meterEphemeralSandbox(
          controlPlane,
          "cloudflare",
          id,
          request.metadata,
          () => configuredSandboxSpecs(this.#config),
        );
    try {
      const response = await this.#exec(
        id,
        [
          "bash",
          "-c",
          RUN_IN_CWD,
          "bash",
          requiredWorkspacePath(request, "/workspace"),
          request.code,
          ...(request.args ?? []),
        ],
        request,
        reserved !== undefined,
      );
      if (reserved && key) this.#mirror(key, reserved, request.metadata);

      return execRunResult(request, response, "cloudflare", startedAt);
    } finally {
      if (!reserved) {
        waitUntil(
          this.#destroy(id).then(
            (): void => endMeter?.(),
            (error: unknown): void =>
              logWarn("cloudflare sandbox destroy failed", {
                id: id,
                error: toErrorMessage(error),
              }),
          ),
        );
      }
    }
  }

  async getInstanceInfo(
    request: SandboxReservationRef,
  ): Promise<SandboxInstanceInfo | null> {
    const key = sandboxReservationKey(request);
    const id = key ? await getSandboxExternalId("cloudflare", key) : null;
    if (!id) return null;
    const response = await callPlatformWorker(
      cloudflareConnection(),
      LABEL,
      `/v1/sandboxes/${id}`,
      "GET",
    );
    const { running } = statusResult.parse(await response.json());

    return running ? { externalId: id, state: "running" } : null;
  }

  async prewarm(request: SandboxReservationRef): Promise<void> {
    const key = sandboxReservationKey(request);
    if (this.#config.persistent !== true || !key) return;
    const id = await reservePlatformSandbox(
      "cloudflare",
      this.#config.controlPlane?.accountId,
      key,
    );
    if (!id) return;
    await this.#exec(
      id,
      ["true"],
      { timeoutSeconds: 30, outputLimitBytes: 1024 },
      true,
    );
    this.#mirror(key, id, undefined);
  }

  async release(request: SandboxReleaseRequest): Promise<void> {
    await releasePlatformSandbox(
      "cloudflare",
      this.#config.controlPlane?.accountId,
      request,
      (id): Promise<void> => this.#destroy(id),
    );
  }

  async #destroy(id: string): Promise<void> {
    await callPlatformWorker(
      cloudflareConnection(),
      LABEL,
      `/v1/sandboxes/${id}`,
      "DELETE",
    );
  }

  async #exec(
    id: string,
    argv: string[],
    request: Pick<
      SandboxRunRequest,
      "envVars" | "outputLimitBytes" | "principal" | "timeoutSeconds"
    >,
    reserved: boolean,
  ): Promise<SandboxExecResponse> {
    const timeoutMs = Math.min(request.timeoutSeconds * 1000, MAX_TIMEOUT_MS);
    const response = await callPlatformWorker(
      cloudflareConnection(),
      LABEL,
      `/v1/sandboxes/${id}/exec`,
      "POST",
      {
        argv: argv,
        env: mergeSandboxEnv(
          this.#config.envVars,
          request.envVars,
          request.principal,
        ),
        timeoutMs: timeoutMs,
        outputLimitBytes: Math.min(request.outputLimitBytes, MAX_OUTPUT_BYTES),
        idleTimeoutSeconds: reserved
          ? resolveSandboxLifecycle(this.#config.lifecycle).idleTimeoutSeconds
          : Math.ceil(timeoutMs / 1000) + EPHEMERAL_IDLE_GRACE_SECONDS,
        enableInternet: this.#config.network?.mode === "allow-all",
        instance: CLOUDFLARE_INSTANCE_TYPES[this.#config.size ?? "xsmall"].name,
      },
      timeoutMs + BRIDGE_OVERHEAD_MS,
    );

    return parseExecResponse(await response.text(), LABEL);
  }

  // Called only once the Container answered, so a start that failed is never billed.
  #mirror(
    key: string,
    id: string,
    metadata: SandboxRunRequest["metadata"],
  ): void {
    void queueMirrorWrite(id, (): Promise<void> =>
      upsertSandboxInstance(
        this.#config.controlPlane,
        "cloudflare",
        key,
        id,
        metadata,
        { specs: configuredSandboxSpecs(this.#config) },
      ),
    );
  }
}
