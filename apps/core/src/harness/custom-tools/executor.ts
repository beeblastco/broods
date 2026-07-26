/**
 * Custom (account-uploaded) tool dispatch and the sandbox-tier invoker. Routes by
 * runtime tier: pure/fetch-only bundles run in the in-core V8 isolate
 * (../isolate/executor.ts); node/npm/native bundles run in the tool-runner Lambda
 * (apps/lambda). Detached-async needs a persistent reservation and is rejected
 * here (#82). Payload shape and frame protocol come from ./payload.ts.
 */

import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { requireEnv } from "../../shared/env.ts";
import { isPlainObject } from "../../shared/object.ts";
import {
  FrameQueue,
  abortSignalFromOptions,
  createRunnerPayload,
  toolBundlesBucket,
  toolCallIdFromOptions,
  type ExecuteAccountToolOptions,
  type RunnerPayload,
} from "./payload.ts";

interface DetachedAsyncToolMetadata {
  resultId: string;
  completePath: string;
  completionToken: string;
  detached: true;
  [key: string]: unknown;
}

interface ToolRunnerResponse {
  stdout?: unknown;
  error?: unknown;
}

let sharedClient: LambdaClient | undefined;

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
    yield* (options.sandboxExecutor ?? streamInLambda)(options);
    return;
  }

  const isolateExecutor =
    options.isolateExecutor ??
    (await import("../isolate/executor.ts")).streamAccountToolInIsolate;
  yield* isolateExecutor(options);
}

export async function* streamInLambda(
  options: ExecuteAccountToolOptions,
  client: LambdaClient = defaultClient(),
): AsyncGenerator<unknown, void, void> {
  const payload = await createRunnerPayload({
    bucket: toolBundlesBucket(),
    tool: options.tool,
    input: options.input,
    config: options.config,
    toolCallId: toolCallIdFromOptions(options.options),
  });
  const abortSignal = abortSignalFromOptions(options.options);
  const stdout = await invoke(client, payload, abortSignal);

  const queue = new FrameQueue();
  queue.push(stdout);
  queue.close();
  for await (const frame of queue.frames()) {
    if (frame.t === "chunk") {
      yield frame.output;
      continue;
    }
    if (frame.t === "final") {
      yield frame.result;
      return;
    }
    if (frame.t === "end") {
      return;
    }
    throw new Error(frame.error || "custom tool sandbox execution failed");
  }
  throw new Error("custom tool sandbox runner did not return a result");
}

function defaultClient(): LambdaClient {
  // Bound every invoke: the SDK's default connection/request timeouts are 0
  // (off). requestTimeout sits above the Lambda's own 35s so the function's
  // graceful error wins normally; connectionTimeout fails a stalled dial fast.
  sharedClient ??= new LambdaClient({
    requestHandler: { connectionTimeout: 5_000, requestTimeout: 45_000 },
  });
  return sharedClient;
}

// Invoke the runner Lambda and return its raw NDJSON stdout. Surfaces Lambda-side
// failures (FunctionError, or the handler's { error }) as thrown errors.
async function invoke(
  client: LambdaClient,
  payload: RunnerPayload,
  abortSignal: AbortSignal | undefined,
): Promise<string> {
  const result = await client.send(
    new InvokeCommand({
      FunctionName: requireEnv("TOOL_RUNNER_FUNCTION_NAME"),
      InvocationType: "RequestResponse",
      Payload: new TextEncoder().encode(JSON.stringify(payload)),
    }),
    abortSignal ? { abortSignal } : {},
  );
  const body = result.Payload
    ? new TextDecoder().decode(result.Payload)
    : "";
  if (result.FunctionError) {
    throw new Error(
      `tool runner Lambda failed: ${lambdaErrorMessage(body, result.FunctionError)}`,
    );
  }
  const parsed = parseResponse(body);
  if (typeof parsed.error === "string" && parsed.error) {
    throw new Error(parsed.error);
  }
  if (typeof parsed.stdout !== "string") {
    throw new Error("tool runner Lambda returned no output");
  }
  return parsed.stdout;
}

function lambdaErrorMessage(body: string, functionError: string): string {
  try {
    const parsed = JSON.parse(body) as { errorMessage?: unknown };
    if (typeof parsed.errorMessage === "string") return parsed.errorMessage;
  } catch {}
  return functionError;
}

function parseResponse(body: string): ToolRunnerResponse {
  if (!body) return {};
  try {
    const parsed = JSON.parse(body) as unknown;
    return isPlainObject(parsed) ? (parsed as ToolRunnerResponse) : {};
  } catch {
    throw new Error("tool runner Lambda returned a non-JSON response");
  }
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
