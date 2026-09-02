/**
 * Hosted MCP server transport (#331 phase 2, micro-batching #397). A hosted
 * row's endpoint is the tool-runner Lambda: this fetch adapter serializes one
 * web request into an mcp-mode runner request, holds it for a few
 * milliseconds so the sibling calls of one model step join the same batch,
 * invokes the Lambda once per batch over InvokeWithResponseStream, reads the
 * NDJSON frames back (../frames.ts), and settles every call in the batch off
 * the frame tagged with its id. Stateless: one invoke per batch, matching the
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

// The parallel tool calls of one model step leave the AI SDK in the same
// macrotask and reach the batcher well under a millisecond apart; the window
// only has to outlast that. 0 disables batching (every batch is size one,
// same code path). The cap bounds what one batch's shared 30s deadline, 16 MB
// output limit, and single vCPU have to absorb.
const DEFAULT_BATCH_WINDOW_MS = 10;
const DEFAULT_BATCH_MAX = 8;

let sharedClient: LambdaClient | undefined;
let sendOverride: HostedMcpSendBatch | null = null;
const openBatches = new Map<string, OpenBatch>();

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

/** One request of a batch; the id is batch-local and tags its frames. */
export interface HostedMcpBatchRequest {
  id: string;
  mcpRequest: HostedMcpRequest;
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
  requests: HostedMcpBatchRequest[];
}

/** A batch's outcome: every request's response or failure, plus the CPU it burned. */
export interface HostedMcpBatchResult {
  responses: Map<string, HostedMcpResponse>;
  errors: Map<string, Error>;
  cpuUsec: number | undefined;
}

/** One tool call waiting in a batch. `onAbort` is set once the batch is in flight. */
interface PendingCall {
  request: HostedMcpRequest;
  aborted: boolean;
  onAbort: (() => void) | null;
  onCpuUsec: ((cpuUsec: number) => void) | undefined;
  resolve: (response: HostedMcpResponse) => void;
  reject: (error: unknown) => void;
}

/** A batch still collecting calls, keyed by tenant bundle. */
interface OpenBatch {
  record: McpRecord;
  calls: PendingCall[];
  timer: ReturnType<typeof setTimeout> | null;
}

type HostedMcpSendBatch = (
  record: McpRecord,
  requests: HostedMcpBatchRequest[],
  abortSignal: AbortSignal,
) => Promise<HostedMcpBatchResult>;

/**
 * A FetchLike for the SDK's StreamableHTTPClientTransport that routes every
 * request through the Lambda host instead of the network. The child stamps
 * the batch's CPU on its terminal frame; onCpuUsec reports this call's share
 * for usage metering.
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
    const result = await enqueueCall(
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

/**
 * Tests and the local stack: replace the Lambda invoke with a local runner
 * that answers one whole batch. Passing null also drops any open batch.
 */
export function setHostedMcpSendBatchForTests(
  send: HostedMcpSendBatch | null,
): void {
  sendOverride = send;
  for (const batch of openBatches.values()) {
    if (batch.timer !== null) clearTimeout(batch.timer);
  }
  openBatches.clear();
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
  abortSignal: AbortSignal,
  queue: FrameQueue,
): Promise<void> {
  const result = await client.send(
    new InvokeWithResponseStreamCommand({
      FunctionName: requireEnv("TOOL_RUNNER_FUNCTION_NAME"),
      InvocationType: "RequestResponse",
      Payload: new TextEncoder().encode(JSON.stringify(payload)),
    }),
    { abortSignal: abortSignal },
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

/**
 * Hold a call in the open batch for its tenant bundle until the window closes
 * or the batch is full, then settle it off the batch's outcome. A call that
 * arrives after the window closed opens the next batch; nobody waits longer
 * than the window. An aborted call drops out of its batch on its own.
 */
function enqueueCall(
  record: McpRecord,
  request: HostedMcpRequest,
  abortSignal: AbortSignal,
  onCpuUsec: ((cpuUsec: number) => void) | undefined,
): Promise<HostedMcpResponse> {
  if (!record.bundleStorageKey || !record.sha256) {
    return Promise.reject(
      new Error(
        `hosted MCP server ${record.name} is missing its uploaded bundle`,
      ),
    );
  }
  if (abortSignal.aborted) return Promise.reject(abortSignal.reason);
  const key = `${record.accountId}:${record.sha256}`;

  return new Promise<HostedMcpResponse>((resolve, reject) => {
    const call: PendingCall = {
      request: request,
      aborted: false,
      onAbort: null,
      onCpuUsec: onCpuUsec,
      resolve: resolve,
      reject: reject,
    };
    abortSignal.addEventListener(
      "abort",
      () => {
        call.aborted = true;
        reject(abortSignal.reason);
        call.onAbort?.();
      },
      { once: true },
    );
    const windowMs = envInt("MCP_BATCH_WINDOW_MS", DEFAULT_BATCH_WINDOW_MS);
    const max = envInt("MCP_BATCH_MAX", DEFAULT_BATCH_MAX);
    const open = openBatches.get(key);
    const batch: OpenBatch = open ?? { record: record, calls: [], timer: null };
    if (!open) {
      openBatches.set(key, batch);
      if (windowMs > 0) {
        batch.timer = setTimeout(() => flushBatch(key, batch), windowMs);
      }
    }
    batch.calls.push(call);
    if (windowMs === 0 || batch.calls.length >= max) flushBatch(key, batch);
  });
}

/** A request's final frame carries its serialized response. */
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

// Close a batch: take it off the map so later calls open a new one, send it,
// and settle every call in it. The invoke itself is abandoned only once every
// call in the batch has been aborted, so one cancelled run cannot cut short a
// sibling's answer.
function flushBatch(key: string, batch: OpenBatch): void {
  if (openBatches.get(key) === batch) openBatches.delete(key);
  if (batch.timer !== null) clearTimeout(batch.timer);
  const live = batch.calls.filter((call) => !call.aborted);
  if (live.length === 0) return;
  const requests = live.map((call, index): HostedMcpBatchRequest => ({
    id: String(index + 1),
    mcpRequest: call.request,
  }));
  const controller = new AbortController();
  for (const call of live) {
    call.onAbort = (): void => {
      if (live.every((sibling) => sibling.aborted)) controller.abort();
    };
  }
  const send = sendOverride ?? sendBatch;
  void send(batch.record, requests, controller.signal).then(
    (result) => {
      // The child measures the batch, not the request. An even split keeps
      // every span carrying a number and the account rollup summing to the
      // true total; it is reported before any call resolves because the
      // harness reads a call's compute the moment its result lands.
      if (typeof result.cpuUsec === "number" && result.cpuUsec > 0) {
        const share = Math.round(result.cpuUsec / live.length);
        for (const call of live) call.onCpuUsec?.(share);
      }
      live.forEach((call, index) => {
        const id = requests[index]!.id;
        const response = result.responses.get(id);
        if (response) call.resolve(response);
        else
          call.reject(
            result.errors.get(id) ??
              new Error(
                `hosted MCP server ${batch.record.name} returned no response`,
              ),
          );
      });
    },
    (error: unknown) => {
      for (const call of live) call.reject(error);
    },
  );
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);

  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

/**
 * One invoke for one batch. Every request's tagged frame lands in the result;
 * `end` closes the batch cleanly, an untagged error frame fails every request
 * still unanswered, and a transport failure fails them all.
 */
async function sendBatch(
  record: McpRecord,
  requests: HostedMcpBatchRequest[],
  abortSignal: AbortSignal,
): Promise<HostedMcpBatchResult> {
  const payload: McpHostPayload = {
    mode: "mcp",
    toolName: record.name,
    accountId: record.accountId,
    expectedSha256: record.sha256!,
    bundleUrl: await getS3ObjectUrl(
      toolBundlesBucket(),
      record.bundleStorageKey!,
      { expiresInSeconds: BUNDLE_URL_TTL_SECONDS },
    ),
    requests: requests,
  };
  const queue = new FrameQueue();
  let transportError: unknown;
  const pump = drainInvokeStream(defaultClient(), payload, abortSignal, queue)
    .catch((error: unknown) => {
      transportError = error;
    })
    .finally(() => queue.close());
  const result: HostedMcpBatchResult = {
    responses: new Map(),
    errors: new Map(),
    cpuUsec: undefined,
  };
  let batchError: Error | undefined;
  try {
    for await (const frame of queue.frames()) {
      if (frame.t === "final" && frame.id !== undefined) {
        try {
          result.responses.set(
            frame.id,
            finalHostedResponse(record.name, frame.result),
          );
        } catch (error) {
          result.errors.set(frame.id, error as Error);
        }
        continue;
      }
      if (frame.t === "error" && frame.id !== undefined) {
        result.errors.set(frame.id, new Error(frame.error));
        continue;
      }
      // A failed batch still burned CPU, so the sample is kept off the
      // terminal frame either way.
      if (frame.t === "end") {
        result.cpuUsec = frame.cpuUsec;
        break;
      }
      if (frame.t === "error") {
        result.cpuUsec = frame.cpuUsec;
        batchError = new Error(
          frame.error || `hosted MCP server ${record.name} run failed`,
        );
        break;
      }
    }
  } finally {
    await pump;
  }
  if (transportError) throw transportError;
  if (batchError) {
    for (const request of requests) {
      if (!result.responses.has(request.id)) {
        result.errors.set(request.id, batchError);
      }
    }
  }

  return result;
}
