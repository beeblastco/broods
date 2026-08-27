/**
 * Entry point. Subscribes to the config planes, reconciles the socket set on
 * every change, and serves a health endpoint so the deployment's probes have
 * something to read.
 *
 * Single replica by design. See `AGENTS.md` in this folder for why this is its
 * own deployment with `strategy: Recreate` rather than a job inside the gateway.
 */

import { forwarderConfigFromEnv } from "./config.ts";
import { watchDiscordConnections } from "./connections.ts";
import { logInfo } from "./log.ts";
import { Forwarder } from "./supervisor.ts";

if (import.meta.main) {
  const config = forwarderConfigFromEnv();
  const forwarder = new Forwarder(config);
  let ready = false;

  // Liveness and readiness are separate on purpose. `/healthz` answers while the
  // process is alive; only `/readyz` waits on the config plane, so a Convex
  // outage cannot turn into a restart loop that spends IDENTIFY budget.
  const server = Bun.serve({
    port: config.port,
    fetch: (request: Request): Response => {
      const path = new URL(request.url).pathname;
      if (path !== "/" && path !== "/healthz" && path !== "/readyz") {
        return new Response("Not found", { status: 404 });
      }
      const status = ready ? "ok" : "starting";
      // Only readiness carries the socket detail. The other two are what the
      // kubelet polls, they need one field, and none of these paths is
      // authenticated — so the bot hints stay off the ones nothing reads.
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

  // Started after the server, not before: subscribing waits on Convex, and a
  // process that has not opened its port yet fails the liveness probe. Readiness
  // stays false until the first snapshot lands, which is the signal that
  // belongs to Convex.
  const watch = watchDiscordConnections(config.planes, (connections): void => {
    forwarder.reconcile(connections);
    ready = true;
  });

  const shutdown = (): void => {
    void watch.close();
    forwarder.stop();
    void server.stop();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
