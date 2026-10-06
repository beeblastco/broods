import type { VerifyCase } from "../harness.ts";
import { agentRun } from "./agent-run.ts";
import { auditLedger } from "./audit-ledger.ts";
import { autoCompaction } from "./auto-compaction.ts";
import { connections } from "./connections.ts";
import { edgeHeaders } from "./edge-headers.ts";
import { manifestSync } from "./manifest-sync.ts";
import { machineSandbox } from "./machine-sandbox.ts";
import { ownBucketSandbox } from "./own-bucket-sandbox.ts";
import { queuedCompact } from "./queued-compact.ts";
import { queuedFollowup } from "./queued-followup.ts";
import { sdkClient } from "./sdk-client.ts";
import { steerAtBoundary } from "./steer-at-boundary.ts";
import { trailingSlash } from "./trailing-slash.ts";
import { webhookHandshake } from "./webhook-handshake.ts";
import { workToolWebhooks } from "./work-tool-webhooks.ts";

/** Every case `local-stack.ts verify` runs, in order. A new end-to-end feature adds one here. */
export const verifyCases: readonly VerifyCase[] = [
  agentRun,
  sdkClient,
  queuedFollowup,
  queuedCompact,
  steerAtBoundary,
  autoCompaction,
  machineSandbox,
  ownBucketSandbox,
  trailingSlash,
  edgeHeaders,
  manifestSync,
  workToolWebhooks,
  webhookHandshake,
  connections,
  auditLedger,
];
