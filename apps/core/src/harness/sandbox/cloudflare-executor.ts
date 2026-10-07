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
import { upsertSandboxInstance } from "../../shared/convex/sandbox-instances.ts";
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
  meterEphemeralSandbox,
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
// How long an ephemeral Container outlives its command if its DELETE fails.
const EPHEMERAL_IDLE_GRACE_SECONDS = 60;
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

  /**
   * Runs one command. A persistent config reuses its reservation's Container;
   * anything else gets a fresh one that is destroyed afterwards.
   */
  async run(request: SandboxRunRequest): Promise<SandboxRunResult> {
    const startedAt = Date.now();
    const key = sandboxReservationKey(request);
    const controlPlane = this.#config.controlPlane;
    const reserved =
      this.#config.persistent === true && key !== undefined
        ? await this.#reserve(key)
        : undefined;
    const id = reserved ?? `fp-e-${crypto.randomUUID()}`;
    const endMeter = reserved
      ? undefined
      : meterEphemeralSandbox(controlPlane, "cloudflare", id, request.metadata);
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
          this.#bridge(`/v1/sandboxes/${id}`, "DELETE").catch(
            (error: unknown): void =>
              logWarn("cloudflare sandbox destroy failed", {
                id: id,
                error: toErrorMessage(error),
              }),
          ),
        );
        endMeter?.();
      }
    }
  }

  /** The reservation's Container while it is up; a stopped one has lost its disk. */
  async getInstanceInfo(
    request: SandboxReservationRef,
  ): Promise<SandboxInstanceInfo | null> {
    const key = sandboxReservationKey(request);
    const id = key ? await getSandboxExternalId("cloudflare", key) : null;
    if (!id) return null;
    const response = await this.#bridge(`/v1/sandboxes/${id}`, "GET");
    const { running } = statusResult.parse(await response.json());

    return running ? { externalId: id, state: "running" } : null;
  }

  /** Starts a persistent reservation's Container before its first command. */
  async prewarm(request: SandboxReservationRef): Promise<void> {
    const key = sandboxReservationKey(request);
    if (this.#config.persistent !== true || !key) return;
    const id = await this.#reserve(key);
    if (!id) return;
    await this.#exec(
      id,
      ["true"],
      { timeoutSeconds: 30, outputLimitBytes: 1024 },
      true,
    );
    this.#mirror(key, id, undefined);
  }

  /** Destroys a reservation's Container and drops the reservation; cleanup and terminate call it. */
  async release(request: SandboxReleaseRequest): Promise<void> {
    const key = sandboxReservationKey(request);
    if (!key) return;
    const id =
      request.expectedExternalId ??
      (await getSandboxExternalId("cloudflare", key));
    if (!id) return;
    await this.#bridge(`/v1/sandboxes/${id}`, "DELETE");
    // A run's mirror upsert may still be queued; wait for it, so the row the
    // caller removes next is not written back after the Container is gone.
    await queueMirrorWrite(id, async (): Promise<void> => {});
    await deleteSandboxInstance(
      "cloudflare",
      key,
      this.#config.controlPlane?.accountId,
      id,
    );
  }

  // One authenticated call to the bridge Worker; a non-2xx answer throws.
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

  // Runs one argv in the sandbox's Container, clamped to the bridge's limits.
  // A reserved Container idles for the configured window; an ephemeral one only
  // a minute past its command, so one whose DELETE failed still stops soon.
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
        idleTimeoutSeconds: reserved
          ? resolveSandboxLifecycle(this.#config.lifecycle).idleTimeoutSeconds
          : Math.ceil(timeoutMs / 1000) + EPHEMERAL_IDLE_GRACE_SECONDS,
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

  // Mirrors a reserved Container into Convex once it answered, so a start that
  // failed is never billed. Recoverable, so it never holds up the command.
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
      ),
    );
  }

  // A Durable Object exists as soon as it is named, so reserving is only the
  // claim: the loser of a race takes the winner's id and creates nothing. An
  // existing reservation is reused by key alone (the dashboard console carries
  // no account); claiming a new one needs the account, so without it the run
  // is ephemeral.
  async #reserve(key: string): Promise<string | undefined> {
    const accountId = this.#config.controlPlane?.accountId;
    const existing = await getSandboxExternalId("cloudflare", key);
    if (existing) {
      await saveSandboxInstance("cloudflare", key, existing, accountId);

      return existing;
    }
    if (!accountId) return undefined;
    const id = `${sandboxNamePrefix(key)}-${crypto.randomUUID().slice(0, 8)}`;
    if (await claimSandboxInstance("cloudflare", key, id, accountId)) return id;
    const winner = await getSandboxExternalId("cloudflare", key);
    if (!winner)
      throw new Error(
        "failed to reserve a cloudflare sandbox (lost the reservation race)",
      );

    return winner;
  }
}
