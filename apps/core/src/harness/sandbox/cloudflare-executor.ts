/**
 * Cloudflare Containers sandbox executor. The Container API only answers inside
 * a Worker, so commands go over authenticated HTTP to the bridge Worker in
 * `apps/cloudflare-sandbox`, which keeps one Durable Object per sandbox id.
 * Reservation bookkeeping stays here. A Container that sleeps loses its disk, so
 * persistence means the same warm machine across calls, not durable files.
 */

import { z } from "zod";
import {
  MAX_OUTPUT_BYTES,
  MAX_TIMEOUT_MS,
} from "../../../../cloudflare-sandbox/src/limits.ts";
import {
  removeSandboxInstance,
  upsertSandboxInstance,
} from "../../shared/convex/sandbox-instances.ts";
import type { SandboxExecResponse } from "../../shared/domain/sandbox-config.ts";
import { optionalEnv } from "../../shared/env.ts";
import { toErrorMessage } from "../../shared/errors.ts";
import { waitUntil } from "../../shared/in-flight.ts";
import { logWarn } from "../../shared/log.ts";
import { resolveSandboxLifecycle } from "../../shared/sandbox.ts";
import type { SandboxSize } from "../../shared/sandbox-sizes.ts";
import {
  claimSandboxInstance,
  deleteSandboxInstance,
  getSandboxExternalId,
  saveSandboxInstance,
} from "./instance-store.ts";
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
  sandboxNamePrefix,
  sandboxReservationKey,
} from "./utils.ts";

// Runs the code under a login bash in its working directory, which may not exist
// yet, with any further arguments as the code's own positional parameters.
const RUN_IN_CWD =
  'mkdir -p -- "$1" && cd -- "$1" && exec bash -lc "$2" bash "${@:3}"';
// Cloudflare's named instance types nearest each size; a custom type needs a whole vCPU.
const CLOUDFLARE_INSTANCES: Record<SandboxSize, string> = {
  tiny: "standard-1",
  xsmall: "standard-1",
  small: "standard-2",
  medium: "standard-3",
  large: "standard-4",
};
// Headroom over the command timeout for the bridge to start the Container.
const BRIDGE_OVERHEAD_MS = 60_000;
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  "127.0.0.1",
  "[::1]",
  "localhost",
]);

const statusResult = z.object({ running: z.boolean() });

/** The platform bridge from core's env; the terminal ticket and every executor call use it. */
export function cloudflareConnection(): { baseURL: string; apiKey: string } {
  const baseURL = optionalEnv("CLOUDFLARE_SANDBOX_URL");
  const apiKey = optionalEnv("CLOUDFLARE_SANDBOX_API_KEY");
  if (!baseURL || !apiKey)
    throw new Error(
      "the cloudflare sandbox provider needs CLOUDFLARE_SANDBOX_URL and CLOUDFLARE_SANDBOX_API_KEY on core",
    );
  // Every call carries the key, so plain HTTP is only for a local `wrangler dev`.
  const { protocol, hostname } = new URL(baseURL);
  if (protocol !== "https:" && !LOOPBACK_HOSTS.has(hostname))
    throw new Error("CLOUDFLARE_SANDBOX_URL must be https outside loopback");

  return { baseURL: baseURL.replace(/\/+$/, ""), apiKey: apiKey };
}

/** Runs bash in a Cloudflare Container; picked by `providerExecutor` for `provider: "cloudflare"`. */
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
    // Without an account the reservation write is skipped, so the run degrades
    // to ephemeral instead of failing, as `claimSandboxInstance` documents.
    const persistent =
      this.#config.persistent === true &&
      key !== undefined &&
      controlPlane?.accountId !== undefined;
    const id = persistent
      ? await this.#reserve(key, request.metadata)
      : `fp-e-${crypto.randomUUID()}`;
    // An ephemeral Container gets a row keyed by its id for the call; the
    // teardown removes it, which meters the call, like the MicroVM and workdir.
    const ephemeralAccountId = persistent ? undefined : controlPlane?.accountId;
    if (ephemeralAccountId)
      void queueMirrorWrite(id, () =>
        upsertSandboxInstance(
          controlPlane,
          "cloudflare",
          id,
          id,
          request.metadata,
          { ephemeral: true },
        ),
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
      );

      return execRunResult(request, response, "cloudflare", startedAt);
    } finally {
      if (!persistent) {
        waitUntil(
          this.#bridge(`/v1/sandboxes/${id}`, "DELETE").catch(
            (error: unknown): void =>
              logWarn("cloudflare sandbox destroy failed", {
                id: id,
                error: toErrorMessage(error),
              }),
          ),
        );
        if (ephemeralAccountId)
          waitUntil(
            queueMirrorWrite(id, () =>
              removeSandboxInstance(ephemeralAccountId, id, id),
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
    const response = await this.#bridge(`/v1/sandboxes/${id}`, "GET");
    const { running } = statusResult.parse(await response.json());

    // A stopped Container has lost its disk, so there is nothing to resume.
    return running ? { externalId: id, state: "running" } : null;
  }

  async prewarm(request: SandboxReservationRef): Promise<void> {
    const key = sandboxReservationKey(request);
    if (
      this.#config.persistent !== true ||
      !key ||
      this.#config.controlPlane?.accountId === undefined
    )
      return;
    const id = await this.#reserve(key, undefined);
    await this.#exec(id, ["true"], {
      timeoutSeconds: 30,
      outputLimitBytes: 1024,
    });
  }

  async release(request: SandboxReleaseRequest): Promise<void> {
    const key = sandboxReservationKey(request);
    if (!key) return;
    const id =
      request.expectedExternalId ??
      (await getSandboxExternalId("cloudflare", key));
    if (!id) return;
    await this.#bridge(`/v1/sandboxes/${id}`, "DELETE");
    await deleteSandboxInstance(
      "cloudflare",
      key,
      this.#config.controlPlane?.accountId,
      id,
    );
  }

  async #bridge(
    path: string,
    method: "DELETE" | "GET" | "POST",
    body?: unknown,
    timeoutMs = 30_000,
  ): Promise<Response> {
    const { baseURL, apiKey } = cloudflareConnection();
    const response = await fetch(`${baseURL}${path}`, {
      method: method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
    if (!response.ok)
      throw new Error(
        `cloudflare sandbox bridge ${method} ${path} failed (${response.status}): ${await response.text()}`,
      );

    return response;
  }

  async #exec(
    id: string,
    argv: string[],
    request: Pick<
      SandboxRunRequest,
      "envVars" | "outputLimitBytes" | "principal" | "timeoutSeconds"
    >,
  ): Promise<SandboxExecResponse> {
    const timeoutMs = Math.min(request.timeoutSeconds * 1000, MAX_TIMEOUT_MS);
    const response = await this.#bridge(
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
        idleTimeoutSeconds: resolveSandboxLifecycle(this.#config.lifecycle)
          .idleTimeoutSeconds,
        enableInternet: this.#config.network?.mode === "allow-all",
        instance: CLOUDFLARE_INSTANCES[this.#config.size ?? "xsmall"],
      },
      timeoutMs + BRIDGE_OVERHEAD_MS,
    );

    return parseExecResponse(
      await response.text(),
      "cloudflare sandbox bridge",
    );
  }

  // A Durable Object exists as soon as it is named, so reserving is only the
  // claim: the loser of a race takes the winner's id and creates nothing.
  async #reserve(
    key: string,
    metadata: SandboxRunRequest["metadata"],
  ): Promise<string> {
    const accountId = this.#config.controlPlane?.accountId;
    const existing = await getSandboxExternalId("cloudflare", key);
    if (existing) {
      await saveSandboxInstance("cloudflare", key, existing, accountId);
      await upsertSandboxInstance(
        this.#config.controlPlane,
        "cloudflare",
        key,
        existing,
        metadata,
      );

      return existing;
    }
    const id = `${sandboxNamePrefix(key)}-${crypto.randomUUID().slice(0, 8)}`;
    if (await claimSandboxInstance("cloudflare", key, id, accountId)) {
      await upsertSandboxInstance(
        this.#config.controlPlane,
        "cloudflare",
        key,
        id,
        metadata,
      );

      return id;
    }
    const winner = await getSandboxExternalId("cloudflare", key);
    if (!winner)
      throw new Error(
        "failed to reserve a cloudflare sandbox (lost the reservation race)",
      );

    return winner;
  }
}
