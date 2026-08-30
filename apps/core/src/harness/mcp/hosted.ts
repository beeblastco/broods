/**
 * Hosted MCP server transport (#331 phase 2). A hosted row's endpoint is the
 * tool-runner Lambda: this fetch adapter serializes one web request into an
 * mcp-mode runner payload, invokes the Lambda over InvokeWithResponseStream,
 * reads the NDJSON frames back (../frames.ts), and rebuilds the child's
 * serialized response. Stateless: one invoke per request, matching the
 * 2026-07-28 transport exactly.
 */

import {
  InvokeWithResponseStreamCommand,
  LambdaClient,
} from "@aws-sdk/client-lambda";
import type { McpRecord } from "../../shared/domain/mcp.ts";
import { requireEnv } from "../../shared/env.ts";
import { getS3ObjectUrl } from "../../shared/s3.ts";
import { FrameQueue, toolBundlesBucket } from "../frames.ts";

/** Placeholder origin the SDK transport points at; never actually dialed. */
export const HOSTED_MCP_URL = "http://mcp-hosted.internal/mcp";

// The runner fetches at the start of a 35s-bounded invocation, so the grant
// only has to outlive a cold start.
const BUNDLE_URL_TTL_SECONDS = 120;

let sharedClient: LambdaClient | undefined;
let invokeOverride: HostedMcpInvoke | null = null;

/** One serialized web request, as the mcp-mode child receives it. */
interface HostedMcpRequest {
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

export interface HostedMcpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * mcp-mode invoke payload; the Lambda handler dispatches on `mode`.
 * `accountId` + `expectedSha256` key the handler's warm-child reuse (#189):
 * a repeat call for the same tenant bundle skips fetch, parse, and spawn.
 */
export interface McpHostPayload {
  mode: "mcp";
  toolName: string;
  accountId: string;
  expectedSha256: string;
  bundleUrl: string;
  mcpRequest: HostedMcpRequest;
}

type HostedMcpInvoke = (
  record: McpRecord,
  request: HostedMcpRequest,
  abortSignal: AbortSignal | undefined,
  onCpuUsec?: (cpuUsec: number) => void,
) => Promise<HostedMcpResponse>;

/**
 * A FetchLike for the SDK's StreamableHTTPClientTransport that routes every
 * request through the Lambda host instead of the network. The child stamps its
 * CPU on the terminal frame; onCpuUsec reports it for usage metering.
 */
export function hostedMcpFetch(
  record: McpRecord,
  onCpuUsec?: (cpuUsec: number) => void,
): typeof fetch {
  return (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    // Bun's Request overloads reject the raw union; narrow the URL form first.
    const request =
      input instanceof Request
        ? new Request(input, init)
        : new Request(String(input), init);
    // The standalone GET SSE stream is a legacy-era long-poll; a per-request
    // Lambda invoke would hold it open until timeout. Hosted rows are pinned
    // modern, which never opens it — refuse it outright as the spec allows.
    if (request.method === "GET") {
      return new Response(null, { status: 405, headers: { allow: "POST" } });
    }
    const body = await request.text();
    const invoke = invokeOverride ?? invokeLambda;
    const result = await invoke(
      record,
      {
        method: request.method,
        headers: Object.fromEntries(request.headers),
        body: body,
      },
      request.signal,
      onCpuUsec,
    );

    return new Response(result.body, {
      status: result.status,
      headers: result.headers,
    });
  }) as typeof fetch;
}

/** Tests and the local stack: replace the Lambda invoke with a local runner. */
export function setHostedMcpInvokeForTests(
  invoke: HostedMcpInvoke | null,
): void {
  invokeOverride = invoke;
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

// Invoke the runner Lambda and push its raw NDJSON payload chunks into the queue
// as they arrive. Surfaces a Lambda-side failure (InvokeComplete.ErrorCode) as a
// thrown error; server-side failures arrive as an `error` frame instead.
async function drainInvokeStream(
  client: LambdaClient,
  payload: McpHostPayload,
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

/** The child answers with one terminal frame carrying the serialized response. */
function finalHostedResponse(
  serverName: string,
  result: unknown,
): HostedMcpResponse {
  const response = result as HostedMcpResponse | undefined;
  if (
    !response ||
    typeof response.status !== "number" ||
    typeof response.body !== "string"
  ) {
    throw new Error(
      `hosted MCP server ${serverName} returned a malformed response`,
    );
  }

  return response;
}

async function invokeLambda(
  record: McpRecord,
  request: HostedMcpRequest,
  abortSignal: AbortSignal | undefined,
  onCpuUsec?: (cpuUsec: number) => void,
): Promise<HostedMcpResponse> {
  if (!record.bundleStorageKey || !record.sha256) {
    throw new Error(
      `hosted MCP server ${record.name} is missing its uploaded bundle`,
    );
  }
  const payload: McpHostPayload = {
    mode: "mcp",
    toolName: record.name,
    accountId: record.accountId,
    expectedSha256: record.sha256,
    bundleUrl: await getS3ObjectUrl(
      toolBundlesBucket(),
      record.bundleStorageKey,
      { expiresInSeconds: BUNDLE_URL_TTL_SECONDS },
    ),
    mcpRequest: request,
  };
  const queue = new FrameQueue();
  let transportError: unknown;
  const pump = drainInvokeStream(defaultClient(), payload, abortSignal, queue)
    .catch((error: unknown) => {
      transportError = error;
    })
    .finally(() => queue.close());
  // A failed run still burned CPU, so the sample is reported off the terminal
  // frame either way — before the error path throws.
  const reportCpu = (cpuUsec: number | undefined): void => {
    if (typeof cpuUsec === "number" && cpuUsec > 0) onCpuUsec?.(cpuUsec);
  };
  try {
    for await (const frame of queue.frames()) {
      if (frame.t === "error") {
        reportCpu(frame.cpuUsec);
        throw new Error(
          frame.error || `hosted MCP server ${record.name} run failed`,
        );
      }
      if (frame.t === "final") {
        reportCpu(frame.cpuUsec);

        return finalHostedResponse(record.name, frame.result);
      }
    }
  } finally {
    await pump;
  }
  if (transportError) throw transportError;

  throw new Error(`hosted MCP server ${record.name} returned no response`);
}
