/**
 * Every case `local-stack.ts verify` runs, in order. A feature that changes
 * what core, gateway, Convex, the SDK or the CLI does end to end adds a case
 * here: one file that drives it through the gateway and asserts the result.
 */

import type { VerifyCase } from "../harness.ts";
import { agentRunCase } from "./agent-run.ts";
import { machineSandboxCase } from "./machine-sandbox.ts";
import { sdkClientCase } from "./sdk-client.ts";

export const verifyCases: readonly VerifyCase[] = [
  agentRunCase,
  sdkClientCase,
  machineSandboxCase,
];
