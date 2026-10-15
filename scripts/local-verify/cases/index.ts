import type { VerifyCase } from "../harness.ts";
import { agentRun } from "./agent-run.ts";
import { auditLedger } from "./audit-ledger.ts";
import { authFailures } from "./auth-failures.ts";
import { autoCompaction } from "./auto-compaction.ts";
import { bashTimeout } from "./bash-timeout.ts";
import { browserSandbox } from "./browser-sandbox.ts";
import { cloudflareSandbox } from "./cloudflare-sandbox.ts";
import { connections } from "./connections.ts";
import { credentialPrefixes } from "./credential-prefixes.ts";
import { customSandbox } from "./custom-sandbox.ts";
import { edgeHeaders } from "./edge-headers.ts";
import { manifestSync } from "./manifest-sync.ts";
import { mcpCommand } from "./mcp-command.ts";
import { mcpHeaderEnv } from "./mcp-header-env.ts";
import { lambdaSnapshot } from "./lambda-snapshot.ts";
import { machineSandbox } from "./machine-sandbox.ts";
import { orgSeatBilling } from "./org-seat-billing.ts";
import { ownBucketSandbox } from "./own-bucket-sandbox.ts";
import { productionRegion } from "./production-region.ts";
import { providerSnapshot } from "./provider-snapshot.ts";
import { queuedCompact } from "./queued-compact.ts";
import { queuedFollowup } from "./queued-followup.ts";
import { r2Workspace } from "./r2-workspace.ts";
import { sandboxImage } from "./sandbox-image.ts";
import { runToken } from "./run-token.ts";
import { sdkClient } from "./sdk-client.ts";
import { skillLimit } from "./skill-limit.ts";
import { snapshotStage } from "./snapshot-stage.ts";
import { storageTrust } from "./storage-trust.ts";
import { steerAtBoundary } from "./steer-at-boundary.ts";
import { streamedBurst } from "./streamed-burst.ts";
import { subagentModel } from "./subagent-model.ts";
import { subagentResume } from "./subagent-resume.ts";
import { subagentStop } from "./subagent-stop.ts";
import { traceFetch } from "./trace-fetch.ts";
import { trailingSlash } from "./trailing-slash.ts";
import { userToken } from "./user-token.ts";
import { webhookHandshake } from "./webhook-handshake.ts";
import { websocketAttachAbort } from "./websocket-attach-abort.ts";
import { websocketRuntimeKey } from "./websocket-runtime-key.ts";
import { workToolWebhooks } from "./work-tool-webhooks.ts";
import { workspaceIsolation } from "./workspace-isolation.ts";

/** Every case `local-stack.ts verify` runs, in order. A new end-to-end feature adds one here. */
export const verifyCases: readonly VerifyCase[] = [
  agentRun,
  sdkClient,
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
  autoCompaction,
  machineSandbox,
  bashTimeout,
  ownBucketSandbox,
  storageTrust,
  sandboxImage,
  lambdaSnapshot,
  providerSnapshot,
  snapshotStage,
  browserSandbox,
  mcpCommand,
  customSandbox,
  cloudflareSandbox,
  trailingSlash,
  edgeHeaders,
  credentialPrefixes,
  manifestSync,
  productionRegion,
  mcpHeaderEnv,
  r2Workspace,
  workToolWebhooks,
  webhookHandshake,
  connections,
  auditLedger,
  runToken,
  workspaceIsolation,
  skillLimit,
  orgSeatBilling,
  // Last: it blocks a source address on the config plane for 15 minutes.
  authFailures,
];
