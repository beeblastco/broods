import type { VerifyCase } from "../harness.ts";
import { agentRun } from "./agent-run.ts";
import { asyncToolHandback } from "./async-tool-handback.ts";
import { auditLedger } from "./audit-ledger.ts";
import { authFailures } from "./auth-failures.ts";
import { autoCompaction } from "./auto-compaction.ts";
import { bashTimeout } from "./bash-timeout.ts";
import { browserSandbox } from "./browser-sandbox.ts";
import { cloudflareSandbox } from "./cloudflare-sandbox.ts";
import { connections } from "./connections.ts";
import { credentialPrefixes } from "./credential-prefixes.ts";
import { edgeHeaders } from "./edge-headers.ts";
import { workerSandbox } from "./worker-sandbox.ts";
import { manifestSync } from "./manifest-sync.ts";
import { mcpCommand } from "./mcp-command.ts";
import { mcpHeaderEnv } from "./mcp-header-env.ts";
import { machineSandbox } from "./machine-sandbox.ts";
import { modelPrices } from "./model-prices.ts";
import { modelTimeout } from "./model-timeout.ts";
import { orgSeatBilling } from "./org-seat-billing.ts";
import { ownBucketSandbox } from "./own-bucket-sandbox.ts";
import { productionRegion } from "./production-region.ts";
import { projectUsage } from "./project-usage.ts";
import { queuedCompact } from "./queued-compact.ts";
import { queuedFollowup } from "./queued-followup.ts";
import { runToken } from "./run-token.ts";
import { scopedAccountKey } from "./scoped-account-key.ts";
import { snapshotStage } from "./snapshot-stage.ts";
import { steerAtBoundary } from "./steer-at-boundary.ts";
import { streamedBurst } from "./streamed-burst.ts";
import { subagentModel } from "./subagent-model.ts";
import { subagentResume } from "./subagent-resume.ts";
import { subagentStop } from "./subagent-stop.ts";
import { traceFetch } from "./trace-fetch.ts";
import { trailingSlash } from "./trailing-slash.ts";
import { userToken } from "./user-token.ts";
import { vercelSandbox } from "./vercel-sandbox.ts";
import { webhookHandshake } from "./webhook-handshake.ts";
import { websocketAttachAbort } from "./websocket-attach-abort.ts";
import { websocketRuntimeKey } from "./websocket-runtime-key.ts";
import { workToolWebhooks } from "./work-tool-webhooks.ts";
import { workspaceIsolation } from "./workspace-isolation.ts";

export const verifyCases: readonly VerifyCase[] = [
  agentRun,
  websocketAttachAbort,
  websocketRuntimeKey,
  traceFetch,
  userToken,
  queuedFollowup,
  queuedCompact,
  steerAtBoundary,
  streamedBurst,
  subagentStop,
  subagentModel,
  subagentResume,
  asyncToolHandback,
  autoCompaction,
  machineSandbox,
  bashTimeout,
  ownBucketSandbox,
  snapshotStage,
  browserSandbox,
  mcpCommand,
  cloudflareSandbox,
  workerSandbox,
  vercelSandbox,
  trailingSlash,
  edgeHeaders,
  credentialPrefixes,
  scopedAccountKey,
  manifestSync,
  productionRegion,
  projectUsage,
  modelPrices,
  modelTimeout,
  mcpHeaderEnv,
  workToolWebhooks,
  webhookHandshake,
  connections,
  auditLedger,
  runToken,
  workspaceIsolation,
  orgSeatBilling,
  // Last: it blocks a source address on the config plane for 15 minutes.
  authFailures,
];
