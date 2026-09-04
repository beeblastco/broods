/**
 * Every case the suite runs, in report order. A case belongs here only if it is
 * on a path that executes per request, per turn, or per streamed line — the
 * suite is a regression gate, not a catalogue.
 */

import type { BenchCase } from "../runner.ts";
import { configPlaneAuthzCases } from "./config-plane-authz.ts";
import { coreAuthCases } from "./core-auth.ts";
import { coreLoggingCases } from "./core-logging.ts";
import { coreRunnerFrameCases } from "./core-runner-frames.ts";
import { coreSessionCases } from "./core-session.ts";
import { gatewayCases } from "./gateway.ts";

export const allCases: readonly BenchCase[] = [
  ...gatewayCases,
  ...coreAuthCases,
  ...coreLoggingCases,
  ...coreRunnerFrameCases,
  ...coreSessionCases,
  ...configPlaneAuthzCases,
];
