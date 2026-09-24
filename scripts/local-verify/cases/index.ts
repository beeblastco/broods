import type { VerifyCase } from "../harness.ts";
import { agentRun } from "./agent-run.ts";
import { machineSandbox } from "./machine-sandbox.ts";
import { queuedFollowup } from "./queued-followup.ts";
import { sdkClient } from "./sdk-client.ts";

/** Every case `local-stack.ts verify` runs, in order. A new end-to-end feature adds one here. */
export const verifyCases: readonly VerifyCase[] = [
  agentRun,
  sdkClient,
  queuedFollowup,
  machineSandbox,
];
