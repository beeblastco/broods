import {
  errorResponse,
  type CoreRequest,
  type RequestContext,
} from "./shared/http.ts";
import {
  optionalEnv,
  positiveIntegerEnv,
  requireEnv,
  requireSecretsEnv,
} from "./shared/env.ts";
import { toErrorMessage } from "./shared/errors.ts";
import { drainInFlight, waitUntil } from "./shared/in-flight.ts";
import {
  resolveRequestId,
  withRequestId,
} from "@broods/convex/model/requestId";
import { logError, logInfo } from "./shared/log.ts";
import { flushObservabilityNats } from "./shared/nats.ts";
import { emitPostHogLog, forceFlushOtel, initOtel } from "./shared/otel.ts";

const DEFAULT_REQUEST_BUDGET_MS = 10 * 60 * 1000;
const INTERRUPT_BUDGET_MS = 3_000;
const INTERRUPTED_RUN_ERROR =
  "The run was interrupted by a core restart. Send the message again.";
const ACCOUNT_RESOURCE_PATTERNS: RegExp[] = [
  /^\/v1\/sandboxes\/[^/]+\/(?:suspend|resume|terminate|snapshot|refresh|exec|terminal)$/,
  /^\/v1\/mcp-service\/rpc$/,
];

// Injected, not imported: a static harness import drags the whole runtime into this file.
export interface CoreRouteHandlers {
  accountHandler: (request: CoreRequest) => Promise<Response>;
  handleMediaRequest: (request: CoreRequest) => Promise<Response>;
  harnessHandler: (
    request: CoreRequest,
    ctx: RequestContext,
  ) => Promise<Response>;
  routesToMedia: (method: string, pathname: string) => boolean;
}

// Routes by path, never Host: Traefik does not pass the client's Host.
export function createRoute(
  handlers: CoreRouteHandlers,
  requestBudgetMs: number,
): (request: Request, socketAddress: string | undefined) => Promise<Response> {
  return async function (request, socketAddress): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz" && request.method === "GET") {
      return withRequestId(
        Response.json({ status: "ok" }),
        resolveRequestId(request.headers.get("x-request-id")),
      );
    }

    const coreRequest = await toCoreRequest(request, url, socketAddress);
    const requestId = resolveRequestId(coreRequest.headers["x-request-id"]);
    const ctx: RequestContext = {
      requestId: requestId,
      deadlineMs: Date.now() + requestBudgetMs,
      waitUntil: waitUntil,
    };

    try {
      let response: Response;
      if (handlers.routesToMedia(request.method, url.pathname)) {
        response = await handlers.handleMediaRequest(coreRequest);
      } else if (routesToAccountManage(request.method, url.pathname)) {
        response = await handlers.accountHandler(coreRequest);
      } else {
        response = await handlers.harnessHandler(coreRequest, ctx);
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
  };
}

export function routesToAccountManage(
  method: string,
  pathname: string,
): boolean {
  const upperMethod = method.toUpperCase();
  if (pathname === "/v1/accounts") {
    return upperMethod === "POST";
  }
  if (/^\/v1\/accounts\/[^/]+$/.test(pathname)) {
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
        .findLast(Boolean) ?? "")
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

if (import.meta.main) {
  const SHUTDOWN_DEADLINE_MS = positiveIntegerEnv(
    "SHUTDOWN_DEADLINE_MS",
    25_000,
  );
  const { handler: accountHandler } = await import("./accounts/handler.ts");
  const { handleMediaRequest, routesToMedia } = await import("./media.ts");
  const { handler: harnessHandler } = await import("./harness/handler.ts");
  const { drainInProcessWorkers } = await import("./harness/worker-queue.ts");
  const { interruptLiveOwners } = await import("./harness/ingress.ts");
  const { startIngressRecovery, stopIngressRecovery } =
    await import("./harness/ingress-recovery.ts");
  const { prewarmIsolatePool, shutdownIsolatePool } =
    await import("./harness/isolate/executor.ts");
  const { startSandboxSweeper, stopSandboxSweeper } =
    await import("./shared/sandbox-sweeper.ts");
  const { startSnapshotBuildWatcher, stopSnapshotBuildWatcher } =
    await import("./shared/sandbox-snapshot-builds.ts");
  const { isMachineUpgrade, machineWebSocketHandler, upgradeMachineSocket } =
    await import("./harness/sandbox/machine-executor.ts");

  requireEnv("SERVICE_AUTH_SECRET");
  requireEnv("STAGE_TICKET_SECRET");
  requireSecretsEnv("MEDIA_TICKET_SECRET");
  requireSecretsEnv("TERMINAL_TICKET_SECRET");

  initOtel();
  void prewarmIsolatePool().catch(() => undefined);
  startSandboxSweeper();
  startSnapshotBuildWatcher();
  startIngressRecovery();

  const route = createRoute(
    {
      accountHandler: accountHandler,
      handleMediaRequest: handleMediaRequest,
      harnessHandler: harnessHandler,
      routesToMedia: routesToMedia,
    },
    positiveIntegerEnv("REQUEST_TIMEOUT_BUDGET_MS", DEFAULT_REQUEST_BUDGET_MS),
  );

  const server = Bun.serve({
    port: positiveIntegerEnv("PORT", 3000),
    hostname: optionalEnv("HOSTNAME") ?? "0.0.0.0",
    idleTimeout: 255,
    maxRequestBodySize: 10 * 1024 * 1024,
    fetch: (request, bunServer) =>
      isMachineUpgrade(request)
        ? upgradeMachineSocket(request, bunServer)
        : route(request, bunServer.requestIP(request)?.address),
    websocket: machineWebSocketHandler,
  });

  logInfo("Core server listening", { port: server.port });
  emitPostHogLog("Core server started", {
    lifecycle: "started",
  });

  let shuttingDown = false;
  const shutdown = async (signal: string, exitCode = 0): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logInfo("Core server shutting down", { signal: signal });
    emitPostHogLog("Core server shutdown started", {
      lifecycle: "shutdown_started",
    });
    stopIngressRecovery();
    let drained = false;
    const deadline = new Promise<void>((resolve) =>
      setTimeout(resolve, SHUTDOWN_DEADLINE_MS),
    );
    const graceful = (async () => {
      await server.stop();
      // An admission in flight can start a worker; a finished worker leaves a usage write.
      await drainInFlight();
      await drainInProcessWorkers();
      await drainInFlight();
      drained = true;
      shutdownIsolatePool();
      stopSandboxSweeper();
      stopSnapshotBuildWatcher();
    })().catch((err) => {
      logError("Graceful shutdown failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
    await Promise.race([graceful, deadline]);
    if (!drained) {
      // Runs outlast the deadline, so fail them and hand their leases back: conversations
      // unlock now, not after the lease TTL, and the next pod's sweep starts their queues.
      const interrupted = await Promise.race([
        interruptLiveOwners(INTERRUPTED_RUN_ERROR),
        new Promise<number>((resolve): void => {
          setTimeout((): void => resolve(-1), INTERRUPT_BUDGET_MS);
        }),
      ]);
      logInfo("Core server interrupted runs past the drain deadline", {
        interrupted: interrupted,
      });
    }
    await Promise.allSettled([forceFlushOtel(), flushObservabilityNats()]);
    process.exit(exitCode);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  // A stray throw would leave every live conversation locked until its lease runs out.
  for (const event of ["unhandledRejection", "uncaughtException"] as const) {
    process.on(event, (error: unknown): void => {
      logError("Core server crashed", {
        event: event,
        error: toErrorMessage(error),
      });
      void shutdown(event, 1);
    });
  }
}
