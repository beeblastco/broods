/**
 * The self-hosted core server (epic #85) — the single entry point.
 *
 * One Bun.serve process fronts the whole runtime: it builds a transport-neutral
 * CoreRequest from each HTTP request and routes by path to the account or harness
 * handler, streaming their Web Response back (SSE included). Routing is by path,
 * never Host — the gateway strips Host on proxy. There is no Lambda runtime.
 */

import type { CoreHandler, CoreRequest, RequestContext } from "./shared/http.ts";
import { optionalEnv, positiveIntegerEnv } from "./shared/env.ts";
import { logError, logInfo } from "./shared/log.ts";
import { forceFlushOtel, initOtel } from "./shared/otel.ts";

const DEFAULT_REQUEST_BUDGET_MS = 10 * 60 * 1000;

export interface CoreServerOptions {
  harnessHandler: CoreHandler;
  accountHandler: CoreHandler;
  /** Per-request work budget (deadline); matches the old 10-minute Lambda cap. */
  requestBudgetMs?: number;
  /** Connection idle timeout; finite so slow/idle (slowloris) connections reap. */
  idleTimeoutSeconds?: number;
  /** Max buffered request body; guards against OOM from large concurrent POSTs. */
  maxRequestBodyBytes?: number;
  port: number;
  hostname?: string;
}

export interface CoreServer {
  server: ReturnType<typeof Bun.serve>;
  /** Settles once all tracked post-response work (waitUntil) finishes. */
  drain: () => Promise<void>;
}

// Account-resource routes under /v1. Patterns are exact-depth (not prefixes)
// so scoped agent invocations like /v1/{project}/agents/{env}/{endpoint} fall
// through to the harness even when a project slug shadows a resource name.
// Skills, tools, and workspace-files CRUD live in the Convex config plane
// (the gateway routes them there), so they are not core routes at all.
const ACCOUNT_RESOURCE_PATTERNS: RegExp[] = [
  /^\/v1\/account(?:\/rotate-secret)?$/,
  /^\/v1\/crons(?:\/[^/]+(?:\/runs)?)?$/,
  /^\/v1\/policies(?:\/[^/]+)?$/,
  /^\/v1\/sandboxes(?:\/[^/]+(?:\/(?:suspend|resume|terminate|snapshot|refresh|exec|terminal))?)?$/,
  /^\/v1\/workspaces(?:\/[^/]+)?$/,
];

/**
 * account-manage owns signup + admin (/accounts), the /v1 account-resource
 * CRUD surface, and the observability-log internal leaf; everything else
 * (direct API, status, async, webhooks, agent invocation) is the harness.
 */
function routesToAccountManage(method: string, pathname: string): boolean {
  if (pathname === "/accounts" || pathname.startsWith("/accounts/")) {
    return true;
  }
  if (pathname === "/v1/internal/observability-log" || pathname === "/v1/agents") {
    return true;
  }
  // /v1/agents/{id}: POST invokes the agent (harness); other methods are CRUD.
  if (/^\/v1\/agents\/[^/]+$/.test(pathname) && method !== "POST") {
    return true;
  }

  return ACCOUNT_RESOURCE_PATTERNS.some((pattern) => pattern.test(pathname));
}

export function createCoreServer(options: CoreServerOptions): CoreServer {
  const requestBudgetMs = options.requestBudgetMs ?? DEFAULT_REQUEST_BUDGET_MS;
  const inFlight = new Set<Promise<void>>();

  const track = (promise: Promise<unknown>): void => {
    const tracked = Promise.resolve(promise)
      .then(() => undefined)
      .catch((err) => {
        logError("Post-response work failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        inFlight.delete(tracked);
      });
    inFlight.add(tracked);
  };

  const server = Bun.serve({
    port: options.port,
    hostname: options.hostname ?? "0.0.0.0",
    // Long enough for SSE quiet gaps between tokens, but finite so idle/slow
    // connections are still reaped. Bun's 10s default is too short for streaming.
    idleTimeout: options.idleTimeoutSeconds ?? 255,
    // The whole body is buffered before auth/routing, so cap it well under the
    // pod memory limit or an unauthenticated caller could OOM the pod.
    maxRequestBodySize: options.maxRequestBodyBytes ?? 10 * 1024 * 1024,
    fetch: async (request, bunServer) => {
      const url = new URL(request.url);
      if (url.pathname === "/healthz" && request.method === "GET") {
        return Response.json({ status: "ok" });
      }

      const coreRequest = await toCoreRequest(request, url, bunServer.requestIP(request)?.address);
      const ctx: RequestContext = {
        requestId: crypto.randomUUID(),
        deadlineMs: Date.now() + requestBudgetMs,
        waitUntil: track,
      };

      try {
        return routesToAccountManage(request.method, url.pathname)
          ? await options.accountHandler(coreRequest, ctx)
          : await options.harnessHandler(coreRequest, ctx);
      } catch (err) {
        logError("Core server handler failed", {
          path: url.pathname,
          error: err instanceof Error ? err.message : String(err),
        });
        return Response.json({ error: "Internal server error" }, { status: 500 });
      }
    },
  });

  return {
    server,
    drain: async () => {
      while (inFlight.size > 0) {
        await Promise.allSettled([...inFlight]);
      }
    },
  };
}

async function toCoreRequest(
  request: Request,
  url: URL,
  socketAddress: string | undefined,
): Promise<CoreRequest> {
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  // Use the RIGHTMOST X-Forwarded-For entry: the single traefik ingress appends
  // the real peer IP, so the last hop is the client IP it observed. A client can
  // only prepend spoofed entries, never overwrite the last one. Security controls
  // (e.g. the signup rate limiter) key on this, so never trust the leftmost entry.
  const forwardedChain = headers["x-forwarded-for"];
  const clientIp = forwardedChain
    ? forwardedChain.split(",").map((entry) => entry.trim()).filter(Boolean).pop() ?? ""
    : socketAddress ?? "";

  const cookies = headers["cookie"]
    ?.split(";")
    .map((cookie) => cookie.trim())
    .filter(Boolean) ?? [];

  return {
    method: request.method,
    path: url.pathname,
    search: url.search.startsWith("?") ? url.search.slice(1) : url.search,
    query: url.searchParams,
    headers,
    // Byte-exact for webhook HMAC checks: JSON webhook payloads are UTF-8.
    body: await request.text(),
    cookies,
    clientIp,
  };
}

// Bootstrap only when run directly. Tests import createCoreServer with mock
// handlers, so the real handlers (and their heavy module graph) load lazily here.
if (import.meta.main) {
  const SHUTDOWN_DEADLINE_MS = positiveIntegerEnv("SHUTDOWN_DEADLINE_MS", 25_000);
  const { handler: accountHandler } = await import("./accounts/handler.ts");
  const { drainInProcessWorkers, handler: harnessHandler } = await import("./harness/handler.ts");

  initOtel();

  const { server, drain } = createCoreServer({
    harnessHandler,
    accountHandler,
    ...(optionalEnv("REQUEST_TIMEOUT_BUDGET_MS")
      ? { requestBudgetMs: positiveIntegerEnv("REQUEST_TIMEOUT_BUDGET_MS", DEFAULT_REQUEST_BUDGET_MS) }
      : {}),
    port: positiveIntegerEnv("PORT", 3000),
    hostname: optionalEnv("HOSTNAME") ?? "0.0.0.0",
  });

  logInfo("Core server listening", { port: server.port });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logInfo("Core server shutting down", { signal });
    const deadline = new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_DEADLINE_MS));
    const graceful = (async () => {
      await server.stop();
      await drain();
      await drainInProcessWorkers();
    })().catch((err) => {
      logError("Graceful shutdown failed", { error: err instanceof Error ? err.message : String(err) });
    });
    await Promise.race([graceful, deadline]);
    await forceFlushOtel().catch(() => undefined);
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}
