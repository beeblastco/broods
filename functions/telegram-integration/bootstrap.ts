// Bun custom runtime entrypoint for the Telegram webhook Lambda.
import { startRuntime } from "../_shared/runtime.ts";
import { handler } from "./handler.ts";

startRuntime(handler);
