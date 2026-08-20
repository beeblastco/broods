/**
 * Entry point. Polls the config plane, reconciles the socket set, and serves a
 * health endpoint so the deployment's probes have something to read.
 *
 * Single replica by design. See `AGENTS.md` in this folder for why this is its
 * own deployment with `strategy: Recreate` rather than a job inside the gateway.
 */

import { forwarderConfigFromEnv } from "./config.ts";
import { listDiscordConnections } from "./connections.ts";
import { logError, logInfo } from "./log.ts";
import { Forwarder } from "./supervisor.ts";

if (import.meta.main) {
  const config = forwarderConfigFromEnv();
  const forwarder = new Forwarder(config);
  let ready = false;

  const poll = async (): Promise<void> => {
    try {
      const connections = await listDiscordConnections();
      forwarder.reconcile(connections);
      ready = true;
    } catch (error) {
      logError("Config plane poll failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  await poll();
  const timer = setInterval(() => void poll(), config.pollIntervalMs);

  // Liveness and readiness are separate on purpose. `/healthz` answers while the
  // process is alive; only `/readyz` waits on the config plane, so a Convex
  // outage cannot turn into a restart loop that spends IDENTIFY budget.
  const server = Bun.serve({
    hostname: process.env.HOSTNAME ?? "0.0.0.0",
    port: config.port,
    fetch: (request: Request): Response => {
      const path = new URL(request.url).pathname;
      if (path !== "/" && path !== "/healthz" && path !== "/readyz") {
        return new Response("Not found", { status: 404 });
      }
      const healthy = path !== "/readyz" || ready;

      return Response.json(
        {
          status: ready ? "ok" : "starting",
          ...forwarder.status(),
        },
        { status: healthy ? 200 : 503 },
      );
    },
  });

  logInfo("Discord forwarder listening", {
    pollIntervalMs: config.pollIntervalMs,
    port: server.port,
    webhookBaseUrl: config.webhookBaseUrl,
  });

  const shutdown = (): void => {
    clearInterval(timer);
    forwarder.stop();
    void server.stop();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
