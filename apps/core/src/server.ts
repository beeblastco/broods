/**
 * The self-hosted core server (epic #85), the single entry point.
 *
 * One Bun.serve process builds a transport-neutral CoreRequest per HTTP request
 * and routes by path to the account or harness handler, streaming their Web
 * Response back (SSE included). By path, never Host: the gateway strips Host on
 * proxy. There is no Lambda runtime.
 */

import {
  errorResponse,
  type CoreRequest,
  type RequestContext,
} from "./shared/http.ts";
import { optionalEnv, positiveIntegerEnv } from "./shared/env.ts";
import { resolveRequestId, withRequestId } from "./shared/request-id.ts";
import { logError, logInfo } from "./shared/log.ts";
import { forceFlushOtel, initOtel } from "./shared/otel.ts";

const DEFAULT_REQUEST_BUDGET_MS = 10 * 60 * 1000;
const ACCOUNT_RESOURCE_PATTERNS: RegExp[] = [
  /^\/v1\/sandboxes\/[^/]+\/(?:suspend|resume|terminate|snapshot|refresh|exec|terminal)$/,
  /^\/v1\/mcp-service\/rpc$/,
];
const inFlight = new Set<Promise<void>>();

export function routesToAccountManage(
  method: string,
  pathname: string,
): boolean {
  const upperMethod = method.toUpperCase();
  if (pathname === "/accounts") {
    return upperMethod === "POST";
  }
  if (/^\/accounts\/[^/]+$/.test(pathname)) {
    return upperMethod === "DELETE";
  }
  if (pathname === "/v1/account") {
    return upperMethod === "DELETE";
  }
  if (ACCOUNT_RESOURCE_PATTERNS.some((pattern) => pattern.test(pathname))) {
    return upperMethod === "POST";
  }

  return false;
}

export async function toCoreRequest(
  request: Request,
  url: URL,
  socketAddress: string | undefined,
): Promise<CoreRequest> {
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  // Trust the rightmost forwarded address added by the ingress, not client input.
  const forwardedChain = headers["x-forwarded-for"];
  const clientIp = forwardedChain
    ? (forwardedChain
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
        .pop() ?? "")
    : (socketAddress ?? "");

  const cookies =
    headers["cookie"]
      ?.split(";")
      .map((cookie) => cookie.trim())
      .filter(Boolean) ?? [];

  return {
    method: request.method,
    path: url.pathname,
    search: url.search.startsWith("?") ? url.search.slice(1) : url.search,
    query: url.searchParams,
    headers: headers,
    body: await request.text(),
    cookies: cookies,
    clientIp: clientIp,
  };
}

export async function drainInFlight(): Promise<void> {
  while (inFlight.size > 0) {
    await Promise.allSettled(inFlight);
  }
}

export function waitUntil(promise: Promise<unknown>): void {
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
}

if (import.meta.main) {
  const SHUTDOWN_DEADLINE_MS = positiveIntegerEnv(
    "SHUTDOWN_DEADLINE_MS",
    25_000,
  );
  const requestBudgetMs = positiveIntegerEnv(
    "REQUEST_TIMEOUT_BUDGET_MS",
    DEFAULT_REQUEST_BUDGET_MS,
  );
  const { handler: accountHandler } = await import("./accounts/handler.ts");
  const { handleMediaRequest, routesToMedia } = await import("./media.ts");
  const { drainInProcessWorkers, handler: harnessHandler } =
    await import("./harness/handler.ts");
  const { prewarmIsolatePool, shutdownIsolatePool } =
    await import("./harness/isolate/executor.ts");
  const { startSandboxSweeper, stopSandboxSweeper } =
    await import("./shared/sandbox-sweeper.ts");

  initOtel();
  // One warm isolate worker so the first uploaded-tool call does not pay Node
  // startup. Failure is not fatal: the pool spawns on demand anyway.
  void prewarmIsolatePool().catch(() => undefined);
  startSandboxSweeper();

  const server = Bun.serve({
    port: positiveIntegerEnv("PORT", 3000),
    hostname: optionalEnv("HOSTNAME") ?? "0.0.0.0",
    idleTimeout: 255,
    maxRequestBodySize: 10 * 1024 * 1024,
    fetch: async (request, bunServer) => {
      const url = new URL(request.url);
      if (url.pathname === "/healthz" && request.method === "GET") {
        return withRequestId(
          Response.json({ status: "ok" }),
          resolveRequestId(request.headers.get("x-request-id")),
        );
      }

      const coreRequest = await toCoreRequest(
        request,
        url,
        bunServer.requestIP(request)?.address,
      );
      const requestId = resolveRequestId(coreRequest.headers["x-request-id"]);
      const ctx: RequestContext = {
        requestId: requestId,
        deadlineMs: Date.now() + requestBudgetMs,
        waitUntil: waitUntil,
      };

      try {
        let response: Response;
        if (routesToMedia(request.method, url.pathname)) {
          response = await handleMediaRequest(coreRequest);
        } else if (routesToAccountManage(request.method, url.pathname)) {
          response = await accountHandler(coreRequest);
        } else {
          response = await harnessHandler(coreRequest, ctx);
        }

        return withRequestId(response, requestId);
      } catch (err) {
        logError("Core server handler failed", {
          path: url.pathname,
          requestId: requestId,
          error: err instanceof Error ? err.message : String(err),
        });

        return withRequestId(
          errorResponse(500, "Internal server error"),
          requestId,
        );
      }
    },
  });

  logInfo("Core server listening", { port: server.port });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logInfo("Core server shutting down", { signal: signal });
    const deadline = new Promise<void>((resolve) =>
      setTimeout(resolve, SHUTDOWN_DEADLINE_MS),
    );
    const graceful = (async () => {
      await server.stop();
      await drainInFlight();
      await drainInProcessWorkers();
      shutdownIsolatePool();
      stopSandboxSweeper();
    })().catch((err) => {
      logError("Graceful shutdown failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
    await Promise.race([graceful, deadline]);
    await forceFlushOtel().catch(() => undefined);
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}
