/**
 * Custom (account-uploaded) tool dispatch. Routes by runtime tier: pure-compute /
 * fetch-only bundles run in the in-core V8 isolate (../isolate/executor.ts);
 * node/npm/native bundles (runtime "sandbox") run in the platform tool-runner
 * Lambda (../sandbox/lambda-tool-executor.ts). Detached-async execution still
 * needs a persistent reservation and is rejected here (tracked in #82). The
 * runner payload shape and frame protocol are shared from ../isolate/payload.ts.
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
 * Tools classified `runtime: "sandbox"` (node/npm/native) run in the tool-runner
 * Lambda. Detached-async tools still need a persistent reservation and are
 * rejected here (tracked in #82) rather than run inline.
 */
export async function* streamAccountTool(
  options: ExecuteAccountToolOptions,
): AsyncGenerator<unknown, void, void> {
  if (isDetachedAsyncTool(extractAsyncToolMetadata(options.options))) {
    throw new Error(
      sandboxUnsupportedMessage(
        options.tool.name,
        "runs as a detached-async job",
      ),
    );
  }

  if (options.tool.runtime === "sandbox") {
    const sandboxExecutor =
      options.sandboxExecutor ??
      (await import("../sandbox/lambda-tool-executor.ts"))
        .streamAccountToolInLambda;
    yield* sandboxExecutor(options);
    return;
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
  return `Custom tool "${toolName}" ${reason}, which is not yet supported off Lambda (tracked in #82). Run it as a synchronous tool instead.`;
}
