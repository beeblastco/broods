/**
 * Cloudflare Containers sandbox executor. The Container API only answers inside
 * a Worker, so commands go over authenticated HTTP to the bridge Worker in
 * `apps/cloudflare-sandbox`, which keeps one Durable Object per sandbox id.
 * Reservation bookkeeping stays here. A Container that sleeps loses its disk, so
 * persistence means the same warm machine across calls, not durable files.
 */

import { z } from "zod";
import { upsertSandboxInstance } from "../../shared/convex/sandbox-instances.ts";
import { optionalEnv } from "../../shared/env.ts";
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
  mergeSandboxEnv,
  requiredWorkspacePath,
  sandboxNamePrefix,
  sandboxReservationKey,
} from "./utils.ts";

// Runs the code under a login bash in its working directory, which may not exist yet.
const RUN_IN_CWD = 'mkdir -p -- "$1" && cd -- "$1" && exec bash -lc "$2"';
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

const execResult = z.object({
  exitCode: z.number().int().nullable(),
  stdout: z.string(),
  stderr: z.string(),
  truncated: z.boolean(),
  timedOut: z.boolean(),
});
const statusResult = z.object({ running: z.boolean() });

/** The platform bridge from core's env; the terminal ticket and every executor call use it. */
export function cloudflareConnection(): { baseURL: string; apiKey: string } {
  const baseURL = optionalEnv("CLOUDFLARE_SANDBOX_URL");
  const apiKey = optionalEnv("CLOUDFLARE_SANDBOX_API_KEY");
  if (!baseURL || !apiKey)
    throw new Error(
      "the cloudflare sandbox provider needs CLOUDFLARE_SANDBOX_URL and CLOUDFLARE_SANDBOX_API_KEY on core",
    );

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
    const persistent = this.#config.persistent === true && key !== undefined;
    const id = persistent
      ? await this.#reserve(key, request.metadata)
      : `fp-e-${crypto.randomUUID()}`;
    try {
      const result = await this.#exec(
        id,
        [
          "bash",
          "-c",
          RUN_IN_CWD,
          "bash",
          requiredWorkspacePath(request, "/workspace"),
          request.code,
        ],
        request,
      );

      return {
        ok: result.exitCode === 0 && !result.timedOut,
        runtime: request.runtime ?? "bash",
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: Date.now() - startedAt,
        timedOut: result.timedOut,
        truncated: result.truncated,
        provider: "cloudflare",
      };
    } finally {
      if (!persistent) await this.#bridge(`/v1/sandboxes/${id}`, "DELETE");
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
    if (this.#config.persistent !== true || !key) return;
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
      "envVars" | "outputLimitBytes" | "timeoutSeconds"
    >,
  ): Promise<z.infer<typeof execResult>> {
    const timeoutMs = request.timeoutSeconds * 1000;
    const response = await this.#bridge(
      `/v1/sandboxes/${id}/exec`,
      "POST",
      {
        argv: argv,
        env: mergeSandboxEnv(this.#config.envVars, request.envVars),
        timeoutMs: timeoutMs,
        outputLimitBytes: request.outputLimitBytes,
        idleTimeoutSeconds: resolveSandboxLifecycle(this.#config.lifecycle)
          .idleTimeoutSeconds,
        enableInternet: this.#config.network?.mode === "allow-all",
        instance: CLOUDFLARE_INSTANCES[this.#config.size ?? "xsmall"],
      },
      timeoutMs + BRIDGE_OVERHEAD_MS,
    );

    return execResult.parse(await response.json());
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
        "failed to reserve a cloudflare sandbox: persistent runs need an account-scoped reservation",
      );

    return winner;
  }
}
