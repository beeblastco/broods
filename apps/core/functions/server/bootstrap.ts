/**
 * Container bootstrap for the self-hosted core runtime (epic #85 phase 9a).
 * One process serves both handlers, routed by Host header; the Lambda
 * bootstraps under functions/{harness-processing,account-manage}/ stay as-is.
 */

import { optionalEnv } from "../_shared/env.ts";
import { logInfo } from "../_shared/log.ts";
import { forceFlushOtel, initOtel } from "../_shared/otel.ts";
import { handler as accountHandler } from "../account-manage/handler.ts";
import { drainInProcessWorkers, handler as harnessHandler } from "../harness-processing/handler.ts";
import { createCoreServer } from "./http-server.ts";

initOtel();

const { server, drain } = createCoreServer({
  harnessHandler,
  accountHandler,
  accountManageHosts: (optionalEnv("ACCOUNT_MANAGE_HOSTS") ?? "").split(","),
  ...(optionalEnv("REQUEST_TIMEOUT_BUDGET_MS")
    ? { requestBudgetMs: Number(optionalEnv("REQUEST_TIMEOUT_BUDGET_MS")) }
    : {}),
  port: Number(optionalEnv("PORT") ?? "3000"),
  hostname: optionalEnv("HOSTNAME") ?? "0.0.0.0",
});

logInfo("Core server listening", { port: server.port });

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logInfo("Core server shutting down", { signal });
  await server.stop();
  await drain();
  await drainInProcessWorkers();
  await forceFlushOtel();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
