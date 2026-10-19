/**
 * What the executors behind a platform Cloudflare Worker share: the bridge
 * for `cloudflare` and the isolate Worker for `worker`. Both reach their
 * Worker over bearer-authenticated HTTPS from core's env, and both reserve a
 * persistent sandbox as a claim on an id, since the Worker-side resource
 * exists as soon as it is named. Provider-specific calls stay in each executor.
 */

import { optionalEnv } from "../../shared/env.ts";
import {
  claimSandboxInstance,
  deleteSandboxInstance,
  getSandboxExternalId,
  saveSandboxInstance,
} from "./instance-store.ts";
import type { SandboxProvider, SandboxReleaseRequest } from "./types.ts";
import {
  queueMirrorWrite,
  sandboxNamePrefix,
  sandboxReservationKey,
} from "./utils.ts";

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  "127.0.0.1",
  "[::1]",
  "localhost",
]);
const DEFAULT_CALL_TIMEOUT_MS = 30_000;

/** A platform Worker's URL and the bearer every call carries. */
export interface PlatformWorkerConnection {
  baseURL: string;
  apiKey: string;
}

/** A non-2xx answer from a platform Worker, with its status for the caller to branch on. */
export class PlatformWorkerError extends Error {
  readonly status: number;

  constructor(label: string, path: string, status: number, body: string) {
    super(`${label} ${path} failed (${status}): ${body}`);
    this.status = status;
  }
}

/** One authenticated call to a platform Worker; a non-2xx answer throws `PlatformWorkerError`. */
export async function callPlatformWorker(
  connection: PlatformWorkerConnection,
  label: string,
  path: string,
  method: "DELETE" | "GET" | "POST",
  body?: unknown,
  timeoutMs: number = DEFAULT_CALL_TIMEOUT_MS,
): Promise<Response> {
  const response = await fetch(`${connection.baseURL}${path}`, {
    method: method,
    headers: {
      Authorization: `Bearer ${connection.apiKey}`,
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "error",
  });
  if (!response.ok)
    throw new PlatformWorkerError(
      label,
      `${method} ${path}`,
      response.status,
      await response.text(),
    );

  return response;
}

/**
 * The platform Worker from core's env. Every call carries the key, so plain
 * HTTP is only for a local `wrangler dev` on loopback.
 */
export function platformWorkerConnection(
  urlEnv: string,
  keyEnv: string,
  provider: SandboxProvider,
): PlatformWorkerConnection {
  const baseURL = optionalEnv(urlEnv);
  const apiKey = optionalEnv(keyEnv);
  if (!baseURL || !apiKey)
    throw new Error(
      `the ${provider} sandbox provider needs ${urlEnv} and ${keyEnv} on core`,
    );
  const { protocol, hostname } = new URL(baseURL);
  if (protocol !== "https:" && !LOOPBACK_HOSTS.has(hostname))
    throw new Error(`${urlEnv} must be https outside loopback`);

  return { baseURL: baseURL.replace(/\/+$/, ""), apiKey: apiKey };
}

/**
 * Drops a reservation's Worker-side resource with `drop`, then the
 * reservation. A run's mirror upsert may still be queued, so it is waited
 * for first: the row the caller removes next must not be written back after
 * the resource is gone.
 */
export async function releasePlatformSandbox(
  provider: SandboxProvider,
  accountId: string | undefined,
  request: SandboxReleaseRequest,
  drop: (id: string) => Promise<void>,
): Promise<void> {
  const key = sandboxReservationKey(request);
  if (!key) return;
  const id =
    request.expectedExternalId ?? (await getSandboxExternalId(provider, key));
  if (!id) return;
  await drop(id);
  await queueMirrorWrite(id, async (): Promise<void> => {});
  await deleteSandboxInstance(provider, key, accountId, id);
}

/**
 * The reservation under `key`: the existing id, else a fresh claim. The
 * Worker-side resource exists as soon as it is named, so reserving is only
 * the claim, and the loser of a race takes the winner's id and creates
 * nothing. An existing reservation is reused by key alone (the dashboard
 * console carries no account), its deadline refreshed before the command so
 * the sweeper cannot take the row from under it; claiming a new one needs
 * the account, so without it the run is ephemeral.
 */
export async function reservePlatformSandbox(
  provider: SandboxProvider,
  accountId: string | undefined,
  key: string,
): Promise<string | undefined> {
  const existing = await getSandboxExternalId(provider, key);
  if (existing) {
    await saveSandboxInstance(provider, key, existing, accountId);

    return existing;
  }
  if (!accountId) return undefined;
  const id = `${sandboxNamePrefix(key)}-${crypto.randomUUID().slice(0, 8)}`;
  if (await claimSandboxInstance(provider, key, id, accountId)) return id;
  const winner = await getSandboxExternalId(provider, key);
  if (!winner)
    throw new Error(
      `failed to reserve a ${provider} sandbox (lost the reservation race)`,
    );

  return winner;
}
