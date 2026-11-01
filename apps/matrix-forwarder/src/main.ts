import { watchChannelConnections } from "../../discord-forwarder/src/connections.ts";
import {
  logError,
  logInfo,
  setLogService,
} from "../../discord-forwarder/src/log.ts";
import { MatrixAccount } from "./account.ts";
import { forwarderConfigFromEnv } from "./config.ts";
import { planeMatrixConnections } from "./connections.ts";
import { handleRequest } from "./server.ts";
import { Forwarder, type ForwarderAccount } from "./supervisor.ts";

if (import.meta.main) {
  setLogService("matrix-forwarder");
  const config = forwarderConfigFromEnv();
  const forwarder = new Forwarder(
    config.storeDir,
    (options): ForwarderAccount => new MatrixAccount(options),
  );
  let ready = false;

  const server = Bun.serve({
    // A Matrix event is capped at 64 KiB, so no honest send comes near this.
    maxRequestBodySize: 1024 * 1024,
    port: config.port,
    fetch: (request: Request): Promise<Response> =>
      handleRequest(forwarder, ready, request),
  });

  logInfo("Matrix forwarder listening", {
    planes: config.planes.map((plane): string => plane.name).join(","),
    port: server.port,
  });

  // After the server: subscribing waits on Convex, and a closed port fails the liveness probe.
  const watch = watchChannelConnections(
    "matrix",
    config.planes,
    planeMatrixConnections,
    (connections): void => {
      forwarder.reconcile(connections);
      ready = true;
    },
  );

  let stopping = false;
  const shutdown = async (exitCode = 0): Promise<void> => {
    if (stopping) return;
    stopping = true;
    try {
      await watch.close();
      // Server first, so no send lands on an account the forwarder already dropped (a 401).
      await server.stop();
      await forwarder.stop();
    } finally {
      process.exit(exitCode);
    }
  };
  process.on("SIGTERM", (): void => void shutdown());
  process.on("SIGINT", (): void => void shutdown());
  for (const event of ["unhandledRejection", "uncaughtException"] as const) {
    process.on(event, (error: unknown): void => {
      logError("Matrix forwarder crashed", {
        event: event,
        error: error instanceof Error ? error.message : String(error),
      });
      void shutdown(1);
    });
  }
}
