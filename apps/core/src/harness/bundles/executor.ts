/**
 * Uploaded-tool dispatch and the sandbox-tier invoker. Routes by
 * runtime tier: pure/fetch-only bundles run in the in-core V8 isolate
 * (../isolate/executor.ts); node/npm/native bundles run in the tool-runner Lambda
 * (apps/lambda). Detached-async needs a persistent reservation and is rejected
 * here (#82). Payload shape and frame protocol come from ./payload.ts.
 */

import {
  InvokeWithResponseStreamCommand,
  LambdaClient,
} from "@aws-sdk/client-lambda";
import { requireEnv } from "../../shared/env.ts";
import { isPlainObject } from "../../shared/object.ts";
import { emitIsolateLog } from "../isolate/executor.ts";
import {
  FrameQueue,
  abortSignalFromOptions,
  createRunnerPayload,
  experimentalContextFromOptions,
  messagesFromOptions,
  toolBundlesBucket,
  toolCallIdFromOptions,
  type ExecuteAccountToolOptions,
} from "./payload.ts";

interface DetachedAsyncToolMetadata {
  resultId: string;
  completePath: string;
  completionToken: string;
  detached: true;
  [key: string]: unknown;
}

let sharedClient: LambdaClient | undefined;

/**
 * Streaming entry used by the AI SDK tool adapter (custom.tool.ts). An
 * async-generator execute streams each yield (surfaced as a preliminary tool
 * result on the SSE path); a normal bundle yields exactly once, its result.
 * Isolate bundles run in the in-core V8 isolate; bundles classified
 * `runtime: "sandbox"` (node/npm/native) stream out of the tool-runner Lambda
 * over InvokeWithResponseStream. Detached-async tools still need a persistent
 * reservation and are rejected here (tracked in #82) rather than run inline.
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
    messages: messagesFromOptions(options.options),
    experimentalContext: experimentalContextFromOptions(options.options),
    bundleTransport: "presigned-url",
  });
  const abortSignal = abortSignalFromOptions(options.options);
  const queue = new FrameQueue();
  let transportError: unknown;
  // Fill the queue in the background so each NDJSON line reaches the agent loop
  // as the Lambda writes it, rather than after the whole run has finished.
  const pump = drainInvokeStream(client, payload, abortSignal, queue)
    .catch((error: unknown) => {
      transportError = error;
    })
    .finally(() => queue.close());

  // A failed run still burned CPU, so the sample is reported off the terminal
  // frame either way — before the error path throws.
  const reportCpu = (cpuUsec: number | undefined): void => {
    if (!(typeof cpuUsec === "number") || !(cpuUsec > 0)) return;
    const toolCallId = toolCallIdFromOptions(options.options);
    options.onSandboxCpu?.({
      type: "custom-tool-sandbox",
      role: "tool",
      toolName: options.tool.name,
      ...(toolCallId !== undefined ? { toolCallId: toolCallId } : {}),
      cpuUsec: cpuUsec,
    });
  };

  try {
    for await (const frame of queue.frames()) {
      if (frame.t === "chunk") {
        yield frame.output;
        continue;
      }
      if (frame.t === "final") {
        reportCpu(frame.cpuUsec);
        yield frame.result;

        return;
      }
      if (frame.t === "end") {
        return;
      }
      if (frame.t === "log") {
        emitIsolateLog(options.accountId, options.tool.name, frame);
        continue;
      }
      // Only an error frame is fatal. Falling through on anything else would
      // turn a frame type a newer runner learns to send into a failed tool call
      // reported as "sandbox execution failed", with no error to explain it.
      if (frame.t !== "error") continue;
      reportCpu(frame.cpuUsec);
      throw new Error(frame.error || "custom tool sandbox execution failed");
    }
  } finally {
    await pump;
  }
  if (transportError) throw transportError;

  throw new Error("custom tool sandbox runner did not return a result");
}

export function defaultClient(): LambdaClient {
  // Bound every invoke: the SDK's default connection/request timeouts are 0
  // (off). requestTimeout sits above the Lambda's own 35s so the function's
  // graceful error wins normally; connectionTimeout fails a stalled dial fast.
  sharedClient ??= new LambdaClient({
    requestHandler: { connectionTimeout: 5_000, requestTimeout: 45_000 },
  });

  return sharedClient;
}

// Invoke the runner Lambda and push its raw NDJSON payload chunks into the queue
// as they arrive. Surfaces a Lambda-side failure (InvokeComplete.ErrorCode) as a
// thrown error; tool-side failures arrive as an `error` frame instead. The
// payload is serialized verbatim: its shape is owned by the caller (tool runs
// send a RunnerPayload, the hosted MCP transport its mcp-mode payload).
export async function drainInvokeStream(
  client: LambdaClient,
  payload: object,
  abortSignal: AbortSignal | undefined,
  queue: FrameQueue,
): Promise<void> {
  const result = await client.send(
    new InvokeWithResponseStreamCommand({
      FunctionName: requireEnv("TOOL_RUNNER_FUNCTION_NAME"),
      InvocationType: "RequestResponse",
      Payload: new TextEncoder().encode(JSON.stringify(payload)),
    }),
    abortSignal ? { abortSignal: abortSignal } : {},
  );
  // Chunk boundaries fall anywhere, including mid-codepoint, so the decoder has
  // to carry state across them.
  const decoder = new TextDecoder();
  for await (const event of result.EventStream ?? []) {
    const chunk = event.PayloadChunk?.Payload;
    if (chunk) {
      queue.push(decoder.decode(chunk, { stream: true }));
      continue;
    }
    const errorCode = event.InvokeComplete?.ErrorCode;
    if (errorCode) {
      throw new Error(
        `tool runner Lambda failed: ${event.InvokeComplete?.ErrorDetails || errorCode}`,
      );
    }
  }
  queue.push(decoder.decode());
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
