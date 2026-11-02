/**
 * What the executors behind a platform Cloudflare Worker share: the bridge
 * for `cloudflare` and the V8 Worker for `worker`. Both reach their
 * Worker over bearer-authenticated HTTPS from core's env, and both reserve a
 * persistent sandbox as a claim on an id, since the Worker-side resource
 * exists as soon as it is named. Provider-specific calls stay in each executor.
 */

import { optionalEnv } from "../../shared/env.ts";
import { waitUntil } from "../../shared/in-flight.ts";
import {
  deleteSandboxInstance,
  getSandboxExternalId,
  reserveSandboxInstance,
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
// How long a held reservation is trusted before it is re-read and its idle
// deadline pushed out again, in the background. Far inside the 7-day TTL.
const REVALIDATE_MS = 60_000;
const MAX_HELD = 10_000;

/**
 * Reservations this process already resolved, by provider and key. The process
 * that runs a sandbox's commands keeps the key-to-id mapping in memory, so a
 * command on a held reservation makes no Convex call; bookkeeping (re-reading
 * the row, refreshing the idle deadline) runs in the background at most once
 * per `REVALIDATE_MS`. A key released or repointed elsewhere drops out at its
 * next check; one released here drops out at once.
 */
const held = new Map<string, { id: string; checkedAt: number }>();

function heldKey(provider: SandboxProvider, key: string): string {
  return `${provider}\u0000${key}`;
}

function hold(provider: SandboxProvider, key: string, id: string): void {
  if (held.size >= MAX_HELD) {
    const oldest = held.keys().next().value;
    if (oldest !== undefined) held.delete(oldest);
  }
  held.set(heldKey(provider, key), { id: id, checkedAt: Date.now() });
}

// Re-reads a held reservation and refreshes its idle deadline; a key that no
// longer names this id, or a failed check (an account no longer active), is
// let go so the next command takes the blocking path and its errors.
async function revalidate(
  provider: SandboxProvider,
  accountId: string | undefined,
  key: string,
  id: string,
): Promise<void> {
  try {
    if ((await getSandboxExternalId(provider, key)) !== id) {
      held.delete(heldKey(provider, key));

      return;
    }
    await saveSandboxInstance(provider, key, id, accountId);
  } catch (error) {
    held.delete(heldKey(provider, key));
    throw error;
  }
}

export function resetHeldReservationsForTests(): void {
  held.clear();
}

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
  held.delete(heldKey(provider, key));
  const id =
    request.expectedExternalId ?? (await getSandboxExternalId(provider, key));
  if (!id) return;
  await drop(id);
  await queueMirrorWrite(id, async (): Promise<void> => {});
  await deleteSandboxInstance(provider, key, accountId, id);
}

/**
 * The reservation under `key`: the existing id, else a fresh claim, in one
 * Convex round trip. The Worker-side resource exists as soon as it is named,
 * so reserving is only the claim, and the loser of a race takes the winner's
 * id and creates nothing. An existing reservation's deadline is refreshed
 * before the command so the sweeper cannot take the row from under it.
 * Without the account (the dashboard console carries none) an existing
 * reservation is reused by key alone and nothing new is claimed, so the run
 * is ephemeral. Once resolved, the reservation is held in memory and later
 * commands skip Convex (`held`).
 */
export async function reservePlatformSandbox(
  provider: SandboxProvider,
  accountId: string | undefined,
  key: string,
): Promise<string | undefined> {
  const hit = held.get(heldKey(provider, key));
  if (hit) {
    if (Date.now() - hit.checkedAt >= REVALIDATE_MS) {
      hit.checkedAt = Date.now();
      waitUntil(revalidate(provider, accountId, key, hit.id));
    }

    return hit.id;
  }
  if (!accountId) {
    const existing = await getSandboxExternalId(provider, key);
    if (existing) hold(provider, key, existing);

    return existing ?? undefined;
  }
  const id = await reserveSandboxInstance(
    provider,
    key,
    `${sandboxNamePrefix(key)}-${crypto.randomUUID().slice(0, 8)}`,
    accountId,
  );
  hold(provider, key, id);

  return id;
}
