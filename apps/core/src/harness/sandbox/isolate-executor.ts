/**
 * Isolate sandbox executor: bash in a V8 isolate on Cloudflare Workers, no
 * container. Commands go over authenticated HTTP to the Worker in
 * `apps/cloudflare-isolate`, which runs each in a Dynamic Worker per sandbox
 * id and keeps a reserved sandbox's files in R2 between calls. Nothing runs
 * between commands, so a persistent sandbox is its stored files, not a warm
 * machine. Reservation bookkeeping stays here.
 */

import { z } from "zod";
import {
  MAX_OUTPUT_BYTES,
  MAX_TIMEOUT_MS,
} from "../../../../cloudflare-isolate/src/limits.ts";
import { upsertSandboxInstance } from "../../shared/convex/sandbox-instances.ts";
import type { SandboxExecResponse } from "../../shared/domain/sandbox-config.ts";
import { optionalEnv } from "../../shared/env.ts";
import type { SandboxRunMetadata } from "../../shared/sandbox-sizes.ts";
import { recordUsage } from "../plan-limits.ts";
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

// Headroom over the command timeout for the Worker to load the isolate and
// move the stored files.
const WORKER_OVERHEAD_MS = 15_000;
// How often one command runs again after another changed the sandbox's
// files under it. The Worker stored nothing for the lost attempt, so the
// rerun starts from the files the other command left.
const CONFLICT_RETRIES = 3;
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  "127.0.0.1",
  "[::1]",
  "localhost",
]);

const statusResult = z.object({ exists: z.boolean() });

/** The Worker's 409: another command changed the files while this one ran. */
class IsolateConflict extends Error {}

/** The platform Worker from core's env; every executor call uses it. */
export function isolateConnection(): { baseURL: string; apiKey: string } {
  const baseURL = optionalEnv("CLOUDFLARE_ISOLATE_URL");
  const apiKey = optionalEnv("CLOUDFLARE_ISOLATE_API_KEY");
  if (!baseURL || !apiKey)
    throw new Error(
      "the isolate sandbox provider needs CLOUDFLARE_ISOLATE_URL and CLOUDFLARE_ISOLATE_API_KEY on core",
    );
  // Every call carries the key, so plain HTTP is only for a local `wrangler dev`.
  const { protocol, hostname } = new URL(baseURL);
  if (protocol !== "https:" && !LOOPBACK_HOSTS.has(hostname))
    throw new Error("CLOUDFLARE_ISOLATE_URL must be https outside loopback");

  return { baseURL: baseURL.replace(/\/+$/, ""), apiKey: apiKey };
}

/** Runs bash in a Cloudflare isolate; picked by `providerExecutor` for `provider: "isolate"`. */
export class IsolateSandboxExecutor implements SandboxExecutor {
  readonly #config: SandboxExecutorConfig;

  constructor(config: SandboxExecutorConfig) {
    if (config.storage)
      throw new Error("the isolate sandbox provider cannot mount workspaces");
    this.#config = config;
  }

  /**
   * Runs one command. A persistent config reuses its reservation's stored
   * files; anything else runs on an empty disk that is gone afterwards, so
   * there is nothing to destroy and no instance row to keep for it. Two
   * commands at once on one reservation each start from the same files, and
   * the Worker stores only the first to finish; the other is run again.
   */
  async run(request: SandboxRunRequest): Promise<SandboxRunResult> {
    const startedAt = Date.now();
    const key = sandboxReservationKey(request);
    const reserved =
      this.#config.persistent === true && key !== undefined
        ? await this.#reserve(key)
        : undefined;
    const id = reserved ?? `fp-e-${crypto.randomUUID()}`;
    for (let attempt = 1; ; attempt++) {
      try {
        const result = await this.#exec(id, request, reserved !== undefined);
        if (reserved && key) this.#mirror(key, reserved, request.metadata);
        this.#meter(result.duration_ms, request.metadata);

        return execRunResult(request, result, "isolate", startedAt);
      } catch (error) {
        if (!(error instanceof IsolateConflict) || attempt > CONFLICT_RETRIES)
          throw error;
      }
    }
  }

  /** A reservation whose files are stored: kept, not running, since nothing runs between calls. */
  async getInstanceInfo(
    request: SandboxReservationRef,
  ): Promise<SandboxInstanceInfo | null> {
    const key = sandboxReservationKey(request);
    const id = key ? await getSandboxExternalId("isolate", key) : null;
    if (!id) return null;
    const response = await this.#worker(`/v1/sandboxes/${id}`, "GET");
    const { exists } = statusResult.parse(await response.json());

    return exists ? { externalId: id, state: "suspended" } : null;
  }

  /** Drops a reservation's stored files and the reservation; cleanup and terminate call it. */
  async release(request: SandboxReleaseRequest): Promise<void> {
    const key = sandboxReservationKey(request);
    if (!key) return;
    const id =
      request.expectedExternalId ??
      (await getSandboxExternalId("isolate", key));
    if (!id) return;
    await this.#worker(`/v1/sandboxes/${id}`, "DELETE");
    // A run's mirror upsert may still be queued; wait for it, so the row the
    // caller removes next is not written back after the files are gone.
    await queueMirrorWrite(id, async (): Promise<void> => {});
    await deleteSandboxInstance(
      "isolate",
      key,
      this.#config.controlPlane?.accountId,
      id,
    );
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
        "isolate",
        key,
        id,
        metadata,
      ),
    );
  }

  // Stored files exist as soon as a command writes under the id, so reserving
  // is only the claim: the loser of a race takes the winner's id and creates
  // nothing. An existing reservation is reused by key alone (the dashboard
  // console carries no account); claiming a new one needs the account, so
  // without it the run is ephemeral.
  async #reserve(key: string): Promise<string | undefined> {
    const accountId = this.#config.controlPlane?.accountId;
    const existing = await getSandboxExternalId("isolate", key);
    if (existing) {
      await saveSandboxInstance("isolate", key, existing, accountId);

      return existing;
    }
    if (!accountId) return undefined;
    const id = `${sandboxNamePrefix(key)}-${crypto.randomUUID().slice(0, 8)}`;
    if (await claimSandboxInstance("isolate", key, id, accountId)) return id;
    const winner = await getSandboxExternalId("isolate", key);
    if (!winner)
      throw new Error(
        "failed to reserve an isolate sandbox (lost the reservation race)",
      );

    return winner;
  }

  // One command on the Worker, clamped to its limits.
  async #exec(
    id: string,
    request: SandboxRunRequest,
    persist: boolean,
  ): Promise<SandboxExecResponse> {
    const timeoutMs = Math.min(request.timeoutSeconds * 1000, MAX_TIMEOUT_MS);
    const response = await this.#worker(
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

    return parseExecResponse(
      await response.text(),
      "cloudflare isolate worker",
    );
  }

  // One authenticated call to the Worker; a non-2xx answer throws.
  async #worker(
    path: string,
    method: "DELETE" | "GET" | "POST",
    body?: unknown,
    timeoutMs = 30_000,
  ): Promise<Response> {
    const { baseURL, apiKey } = isolateConnection();
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
    if (response.status === 409)
      throw new IsolateConflict(await response.text());
    if (!response.ok)
      throw new Error(
        `cloudflare isolate worker ${method} ${path} failed (${response.status}): ${await response.text()}`,
      );

    return response;
  }
}

export type { SandboxExecResponse };
