import { startStreamingRuntime } from "../_shared/runtime.ts";
import { handler } from "./handler.ts";

startStreamingRuntime(handler);
