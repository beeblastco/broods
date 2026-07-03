/**
 * Container bootstrap for the self-hosted core runtime (epic #85 phase 9a).
 * One process serves both handlers, routed by Host header; the Lambda
 * bootstraps under functions/{harness-processing,account-manage}/ stay as-is.
 */

import { optionalEnv, positiveIntegerEnv } from "../_shared/env.ts";
import { logError, logInfo } from "../_shared/log.ts";
import { forceFlushOtel, initOtel } from "../_shared/otel.ts";
import { handler as accountHandler } from "../account-manage/handler.ts";
import { drainInProcessWorkers, handler as harnessHandler } from "../harness-processing/handler.ts";
import { createCoreServer } from "./http-server.ts";

// Cap on graceful drain; a hung request must not block the pod past the k8s
// termination grace period.
const SHUTDOWN_DEADLINE_MS = positiveIntegerEnv("SHUTDOWN_DEADLINE_MS", 25_000);

initOtel();

const { server, drain } = createCoreServer({
  harnessHandler,
  accountHandler,
  accountManageHosts: (optionalEnv("ACCOUNT_MANAGE_HOSTS") ?? "").split(","),
  ...(optionalEnv("REQUEST_TIMEOUT_BUDGET_MS")
    ? { requestBudgetMs: positiveIntegerEnv("REQUEST_TIMEOUT_BUDGET_MS", 10 * 60 * 1000) }
    : {}),
  port: positiveIntegerEnv("PORT", 3000),
  hostname: optionalEnv("HOSTNAME") ?? "0.0.0.0",
});

logInfo("Core server listening", { port: server.port });

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
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
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
