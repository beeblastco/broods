import { positiveIntegerEnv } from "../../core/src/shared/env.ts";
import { forwarderConfigFromEnv } from "./config.ts";
import { planeConnections, watchChannelConnections } from "./connections.ts";
import { logError, logInfo } from "./log.ts";
import { Forwarder } from "./supervisor.ts";

if (import.meta.main) {
  if (process.argv.includes("--healthcheck")) {
    try {
      const response = await fetch(
        `http://127.0.0.1:${positiveIntegerEnv("PORT", 3000)}/healthz`,
        { signal: AbortSignal.timeout(4000) },
      );
      process.exit(response.ok ? 0 : 1);
    } catch {
      process.exit(1);
    }
  }

  const config = forwarderConfigFromEnv();
  const forwarder = new Forwarder(config);
  let ready = false;

  // Only /readyz waits on Convex: an outage must not become a restart loop spending IDENTIFYs.
  const server = Bun.serve({
    port: config.port,
    fetch: (request: Request): Response => {
      const path = new URL(request.url).pathname;
      if (path !== "/" && path !== "/healthz" && path !== "/readyz") {
        return new Response("Not found", { status: 404 });
      }
      const status = ready ? "ok" : "starting";
      // No path here is authenticated, so the token hints stay off all but /readyz.
      if (path !== "/readyz") return Response.json({ status: status });

      return Response.json(
        { status: status, ...forwarder.status() },
        { status: ready ? 200 : 503 },
      );
    },
  });

  logInfo("Discord forwarder listening", {
    planes: config.planes.map((plane): string => plane.name).join(","),
    port: server.port,
  });

  // After the server: subscribing waits on Convex, and an unopened port fails liveness.
  const watch = watchChannelConnections(
    "discord",
    config.planes,
    planeConnections,
    (connections): void => {
      forwarder.reconcile(connections);
      ready = true;
    },
  );

  let stopped: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    if (!stopped) {
      forwarder.stop();
      stopped = Promise.all([watch.close(), server.stop()]).then(
        (): void => undefined,
      );
    }

    return stopped;
  };
  process.on("SIGTERM", (): void => void shutdown());
  process.on("SIGINT", (): void => void shutdown());
  for (const event of ["unhandledRejection", "uncaughtException"] as const) {
    process.on(event, (error: unknown): void => {
      logError("Discord forwarder crashed", {
        event: event,
        error: error instanceof Error ? error.message : String(error),
      });
      void shutdown().finally((): never => process.exit(1));
    });
  }
}
