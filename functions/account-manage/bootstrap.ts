/**
 * Bun runtime bootstrap for the account-manage Lambda.
 * Keep this file minimal and limited to runtime wiring.
 */

import { startStreamingRuntime } from "../_shared/runtime.ts";
import { handler } from "./handler.ts";

startStreamingRuntime(handler);
