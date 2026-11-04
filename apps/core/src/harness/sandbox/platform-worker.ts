import { optionalEnv } from "../../shared/env.ts";
import {
  deleteSandboxInstance,
  getSandboxExternalId,
  reserveSandboxInstance,
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
// A held booking skips Convex until it is this old. The next command books again, which checks
// the account and refreshes the deadline, far inside the 7-day TTL.
const REVALIDATE_MS = 60_000;
const MAX_HELD = 10_000;

// The ids this process booked, by provider and key; a release here lets its key go at once.
const held = new Map<string, { id: string; checkedAt: number }>();
// Bumped as a release ends, so a booking in flight across one is not held.
let releases = 0;

// Re-holding moves the key to the end, so the cap drops the longest unused.
function hold(entry: string, id: string, epoch: number): void {
  if (epoch !== releases) return;
  held.delete(entry);
  if (held.size >= MAX_HELD) {
    const oldest = held.keys().next().value;
    if (oldest !== undefined) held.delete(oldest);
  }
  held.set(entry, { id: id, checkedAt: Date.now() });
}

export function resetHeldReservationsForTests(): void {
  held.clear();
}

export interface PlatformWorkerConnection {
  baseURL: string;
  apiKey: string;
}

export class PlatformWorkerError extends Error {
  readonly status: number;

  constructor(label: string, path: string, status: number, body: string) {
    super(`${label} ${path} failed (${status}): ${body}`);
    this.status = status;
  }
}

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

// Every call carries the key, so plain HTTP is only for a local `wrangler dev` on loopback.
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

export async function releasePlatformSandbox(
  provider: SandboxProvider,
  accountId: string | undefined,
  request: SandboxReleaseRequest,
  drop: (id: string) => Promise<void>,
): Promise<void> {
  const key = sandboxReservationKey(request);
  if (!key) return;
  const entry = `${provider}:${key}`;
  held.delete(entry);
  const id =
    request.expectedExternalId ?? (await getSandboxExternalId(provider, key));
  if (!id) return;
  await drop(id);
  // Drain queued mirror upserts so none writes the row back after the delete.
  await queueMirrorWrite(id, async (): Promise<void> => {});
  await deleteSandboxInstance(provider, key, accountId, id);
  // A command that booked while this ran may hold the dropped id.
  if (held.get(entry)?.id === id) held.delete(entry);
  releases += 1;
}

// A Worker-side resource exists once named, so reserving is just the claim, and a booking
// refreshes the deadline so the sweeper keeps off it. Without an account (the console) an
// existing reservation is reused by key alone and nothing is claimed.
export async function reservePlatformSandbox(
  provider: SandboxProvider,
  accountId: string | undefined,
  key: string,
): Promise<string | undefined> {
  const entry = `${provider}:${key}`;
  const hit = held.get(entry);
  if (hit && Date.now() - hit.checkedAt < REVALIDATE_MS) return hit.id;
  const epoch = releases;
  const id = accountId
    ? await reserveSandboxInstance(
        provider,
        key,
        `${sandboxNamePrefix(key)}-${crypto.randomUUID().slice(0, 8)}`,
        accountId,
      )
    : await getSandboxExternalId(provider, key);
  if (id) hold(entry, id, epoch);

  return id ?? undefined;
}
