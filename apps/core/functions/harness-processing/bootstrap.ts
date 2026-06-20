/**
 * Bun runtime bootstrap for the harness-processing Lambda.
 * Keep this file minimal and limited to runtime wiring.
 */

import { startStreamingRuntime } from "../_shared/runtime.ts";
import { initOtel } from "../_shared/otel.ts";
import { handler } from "./handler.ts";

// Register the OTLP trace/log exporters once per cold start, before any request
// is served. Without this the global OTel API stays noop and the durable
// logs->Loki / traces->Tempo path never fires. Idempotent; no-op when
// OTEL_EXPORTER_OTLP_ENDPOINT is unset.
initOtel();

startStreamingRuntime(handler);
