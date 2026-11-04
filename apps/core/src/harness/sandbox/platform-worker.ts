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
  const id =
    request.expectedExternalId ?? (await getSandboxExternalId(provider, key));
  if (!id) return;
  await drop(id);
  // Drain queued mirror upserts so none writes the row back after the delete.
  await queueMirrorWrite(id, async (): Promise<void> => {});
  await deleteSandboxInstance(provider, key, accountId, id);
}

// A Worker-side resource exists once named, so reserving is just the claim. Reuse goes by key
// alone (the console has no account) and refreshes the deadline so the sweeper keeps off it.
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
