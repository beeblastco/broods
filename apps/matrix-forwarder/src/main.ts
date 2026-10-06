/**
 * Entry point. Subscribes to the config planes' `matrix` connections, reconciles
 * the account set on every change, and serves probes plus core's send and
 * typing calls.
 *
 * Single replica by design: an account's crypto store must never have two
 * writers. See `AGENTS.md` in this folder.
 */

import { watchChannelConnections } from "../../discord-forwarder/src/connections.ts";
import { logInfo, setLogService } from "../../discord-forwarder/src/log.ts";
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

  // Started after the server: subscribing waits on Convex, and a process that
  // has not opened its port yet fails the liveness probe.
  const watch = watchChannelConnections(
    "matrix",
    config.planes,
    planeMatrixConnections,
    (connections): void => {
      forwarder.reconcile(connections);
      ready = true;
    },
  );

  // Every account closes its store before the process exits, so a SIGTERM
  // mid-write cannot corrupt it.
  const shutdown = async (): Promise<void> => {
    await watch.close();
    await forwarder.stop();
    await server.stop();
    process.exit(0);
  };
  process.on("SIGTERM", (): void => void shutdown());
  process.on("SIGINT", (): void => void shutdown());
}
