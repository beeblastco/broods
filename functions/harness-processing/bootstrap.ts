// Bun custom runtime entrypoint for the streaming harness-processing Lambda.
import { startStreamingRuntime } from "../_shared/runtime.ts";
import { handler } from "./handler.ts";

startStreamingRuntime(handler);
