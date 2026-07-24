/**
 * Custom (account-uploaded) tool dispatch. Routes an uploaded tool to the in-core
 * V8 isolate tier (../isolate/executor.ts). Bundles that need node/npm/native
 * (runtime "sandbox") or detached-async execution are not yet supported off
 * Lambda — that external/Firecracker path is deferred to #82. The runner payload
 * shape, frame protocol, and isolate spawning all live under ../isolate/.
 */

import type { ExecuteAccountToolOptions } from "../isolate/payload.ts";
import { isPlainObject } from "../../shared/object.ts";

interface DetachedAsyncToolMetadata {
  resultId: string;
  completePath: string;
  completionToken: string;
  detached: true;
  [key: string]: unknown;
}

/**
 * Streaming entry used by the AI SDK tool adapter (account-tool.tool.ts). Isolate
 * bundles run in the in-core V8 isolate: an async-generator execute streams each
 * yield (surfaced as a preliminary tool result on the sync SSE path); a normal
 * bundle yields exactly once (its result). A sync-returning async generator lets
 * the SDK detect the async-iterable and stream it.
 *
 * Tools classified `runtime: "sandbox"` (node/npm/native) or launched as
 * detached-async need the external Firecracker execution plane, which is not yet
 * wired off Lambda — reject them clearly (tracked in #82) rather than trying to
 * run node code in a V8 isolate.
 */
export async function* streamAccountTool(
  options: ExecuteAccountToolOptions,
): AsyncGenerator<unknown, void, void> {
  if (options.tool.runtime === "sandbox") {
    throw new Error(
      sandboxUnsupportedMessage(
        options.tool.name,
        "needs the sandbox runtime (node/npm or native modules)",
      ),
    );
  }
  if (isDetachedAsyncTool(extractAsyncToolMetadata(options.options))) {
    throw new Error(
      sandboxUnsupportedMessage(
        options.tool.name,
        "runs as a detached-async job",
      ),
    );
  }

  const isolateExecutor =
    options.isolateExecutor ??
    (await import("../isolate/executor.ts")).streamAccountToolInIsolate;
  yield* isolateExecutor(options);
}

function extractAsyncToolMetadata(options: unknown): unknown {
  return isPlainObject(options) ? options.asyncTool : undefined;
}

function isDetachedAsyncTool(
  value: unknown,
): value is DetachedAsyncToolMetadata {
  return (
    isPlainObject(value) &&
    value.detached === true &&
    typeof value.resultId === "string" &&
    typeof value.completePath === "string" &&
    typeof value.completionToken === "string"
  );
}

function sandboxUnsupportedMessage(toolName: string, reason: string): string {
  return `Custom tool "${toolName}" ${reason}, which is not yet supported off Lambda (tracked in #82). Rewrite it as a pure-compute (isolate) tool, or wait for the sandbox execution tier.`;
}
