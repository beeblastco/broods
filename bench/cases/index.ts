/**
 * Every case the suite runs, in report order. A case belongs here only if it is
 * on a path that executes per request, per turn, or per streamed line, or is
 * something a developer waits on every time they use the CLI — the suite is a
 * regression gate, not a catalogue.
 */

import type { BenchCase } from "../runner.ts";
import { cliCases } from "./cli.ts";
import { configPlaneAuthzCases } from "./config-plane-authz.ts";
import { convexRuntimeCases } from "./convex-runtime.ts";
import { coreAuthCases } from "./core-auth.ts";
import { coreConfigCases } from "./core-config.ts";
import { coreIsolateCases } from "./core-isolate.ts";
import { coreLoggingCases } from "./core-logging.ts";
import { coreRunnerFrameCases } from "./core-runner-frames.ts";
import { coreServerCases } from "./core-server.ts";
import { coreSessionCases } from "./core-session.ts";
import { gatewayCases } from "./gateway.ts";

export const allCases: readonly BenchCase[] = [
  ...gatewayCases,
  ...coreServerCases,
  ...coreAuthCases,
  ...coreConfigCases,
  ...coreLoggingCases,
  ...coreRunnerFrameCases,
  ...coreSessionCases,
  ...coreIsolateCases,
  ...configPlaneAuthzCases,
  ...convexRuntimeCases,
  ...cliCases,
];
