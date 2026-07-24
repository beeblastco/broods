/**
 * Sandbox-tier custom tool execution. Invokes the platform tool-runner Lambda
 * (a plain Node.js function; see sandbox/tool-runner/) with the same bundle
 * payload the isolate runner uses, then replays the child's NDJSON frames as the
 * tool's async-generator output. Used by tools/custom-tool-executor.ts for
 * bundles classified runtime "sandbox" (node/npm/native) that the V8 isolate
 * cannot run. Request/response invoke: yields are buffered, not live-streamed.
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
} from "../isolate/payload.ts";

interface ToolRunnerResponse {
  stdout?: unknown;
  error?: unknown;
}

let sharedClient: LambdaClient | undefined;

export async function* streamAccountToolInLambda(
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
