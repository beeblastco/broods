import { dns } from "bun";
import { apiErrorBody, type ApiErrorInit } from "@broods/convex/model/apiError";
export { methodNotAllowed } from "@broods/convex/model/httpJson";
import {
  isDeniedAddress,
  type GuardedFetchOptions,
} from "../harness/isolate/runner/pinned-fetch.mjs";

declare global {
  // Bun 1.4 reads it (`false` = no 300s idle timer); @types/bun 1.3.14 does not declare it.
  interface BunFetchRequestInit {
    timeout?: number | boolean;
  }
}

const PUBLIC_HOST_TTL_MS = 30_000;
const PUBLIC_HOSTS_MAX = 1_024;

const publicHosts = new Map<string, { address: string; expiresAt: number }>();

const PUBLIC_HOST_FETCH: typeof fetch = Object.assign(
  (
    input: string | URL | Request,
    init?: BunFetchRequestInit,
  ): Promise<Response> => publicHostFetch(input, init),
  { preconnect: fetch.preconnect },
);
// Reads the global per call, so a fetch stubbed in later (tests) still applies.
const GLOBAL_FETCH: typeof fetch = Object.assign(
  (
    input: string | URL | Request,
    init?: BunFetchRequestInit,
  ): Promise<Response> => fetch(input, init),
  { preconnect: fetch.preconnect },
);

export interface CoreRequest {
  method: string;
  path: string;
  search: string;
  query: URLSearchParams;
  /** Keys lowercased. */
  headers: Record<string, string>;
  body: string;
  cookies: string[];
  /** Rightmost X-Forwarded-For hop or the socket address, never the spoofable leftmost. */
  clientIp: string;
}

export interface RequestContext {
  requestId: string;
  deadlineMs: number;
  waitUntil(promise: Promise<unknown>): void;
  /** Aborted when the pod's worker pool reclaims this run's slot. */
  abortSignal?: AbortSignal;
  // Resolves once the run holds a slot again, `deadlineMs` moved to it. The lease is the
  // harness's `LiveOwner`, spelled out so the SDK, which typechecks this file, skips the harness.
  yieldSlot?(
    lease:
      | {
          conversationKey: string;
          ownerEventId: string;
          ownerGeneration: number;
        }
      | undefined,
  ): Promise<void>;
}

/** Test seam: `guardedFetch`'s injectable options, never its switches. Production passes none. */
export type PinnedFetchTransport = Pick<
  GuardedFetchOptions,
  "allowAddresses" | "ca" | "lookup"
>;

export function errorResponse(
  status: number,
  message: string,
  init: ApiErrorInit = {},
  headers: Record<string, string> = {},
): Response {
  return jsonResponse(status, apiErrorBody(status, message, init), headers);
}

export function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: status,
    headers: {
      "content-type": "application/json",
      ...headers,
    },
  });
}

export function normalizePath(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

export function parseJsonBody(request: Pick<CoreRequest, "body">): unknown {
  if (!request.body.trim()) {
    return {};
  }

  try {
    return JSON.parse(request.body);
  } catch (err) {
    throw new Error(
      `Invalid request JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// A config-time string check that cannot catch DNS rebinding: fetch with `redirect: "error"`.
export function assertPublicHttpsUrl(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`${label} must use https`);
  }
  if (isPrivateHostname(url.hostname)) {
    throw new Error(`${label} must not point to a private or internal address`);
  }

  return url;
}

export function channelApiFetch(apiUrl: string | undefined): typeof fetch {
  return apiUrl ? PUBLIC_HOST_FETCH : GLOBAL_FETCH;
}

/**
 * For tenant-chosen hosts: refuses any private or metadata address, then connects to the validated
 * one with the name in SNI and `Host`, so nothing can rebind inward. Not `guardedFetch`: the AI
 * SDK needs Bun's streaming `Response`. No redirects: they would leave the pinned address.
 */
export async function publicHostFetch(
  input: string | URL | Request,
  init?: BunFetchRequestInit,
): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const hostname = url.hostname;
  const host = url.host;
  if (isPrivateHostname(hostname)) {
    throw new Error(`Refusing to reach private address ${hostname}`);
  }
  const request = input instanceof Request ? input : undefined;
  const signal = init?.signal ?? request?.signal;
  let validated = publicHosts.get(hostname);
  if (!validated || validated.expiresAt <= Date.now()) {
    const addresses = await lookupUntilAborted(hostname, signal);
    const [pinned] = addresses;
    if (!pinned) {
      throw new Error(`${hostname} did not resolve`);
    }
    if (addresses.some((entry): boolean => isDeniedAddress(entry.address))) {
      throw new Error(`${hostname} resolves to a private address`);
    }
    validated = {
      address: pinned.family === 6 ? `[${pinned.address}]` : pinned.address,
      expiresAt: Date.now() + PUBLIC_HOST_TTL_MS,
    };
    if (publicHosts.size >= PUBLIC_HOSTS_MAX) {
      publicHosts.clear();
    }
    publicHosts.set(hostname, validated);
  }
  url.hostname = validated.address;
  const headers = new Headers(init?.headers ?? request?.headers);
  headers.set("host", host);

  return fetch(url, {
    ...(request
      ? { method: request.method, body: request.body, signal: request.signal }
      : {}),
    ...init,
    headers: headers,
    redirect: "error",
    tls: { serverName: hostname },
  }).catch((error: unknown): never => {
    // Unpin an address that will not connect, so the next call can reach another record.
    publicHosts.delete(hostname);
    throw error;
  });
}

export function resetPublicHostsForTests(): void {
  publicHosts.clear();
}

function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    return true;
  }

  // The URL parser turns `::ffff:10.0.0.1` into hex groups `isDeniedAddress` cannot read.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":")) {
    return host.startsWith("::ffff:") || isDeniedAddress(host);
  }

  return false;
}

async function lookupUntilAborted(
  hostname: string,
  signal: AbortSignal | null | undefined,
): Promise<Awaited<ReturnType<typeof dns.lookup>>> {
  if (!signal) return dns.lookup(hostname);
  signal.throwIfAborted();
  const { promise: aborted, reject } = Promise.withResolvers<never>();
  const onAbort = (): void => reject(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([dns.lookup(hostname), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
