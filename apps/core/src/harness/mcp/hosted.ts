/**
 * Hosted MCP server transport (#331 phase 2, micro-batching #397). A hosted
 * row's endpoint is the Cloudflare Dynamic Workers runtime
 * (apps/cloudflare-mcp) when its bundle can run there and this deployment
 * runs that Worker, the mcp-runner Lambda otherwise: this fetch adapter serializes a web request,
 * batches it with the sibling calls that arrive in the same window, sends
 * the batch once, and once the batch's terminal NDJSON frame (../frames.ts)
 * arrives settles each call off the frame tagged with its id.
 */

import {
  InvokeWithResponseStreamCommand,
  LambdaClient,
} from "@aws-sdk/client-lambda";
import { HOSTED_MCP_MEMORY_GB } from "@broods/convex/model/pricing";
import type { McpRecord } from "../../shared/domain/mcp.ts";
import {
  booleanEnv,
  optionalEnv,
  positiveIntegerEnv,
  requireEnv,
} from "../../shared/env.ts";
import { isUnreachableError, toErrorMessage } from "../../shared/errors.ts";
import { logWarn } from "../../shared/log.ts";
import { getS3ObjectUrl } from "../../shared/s3.ts";
import { FrameQueue, toolBundlesBucket, type RunnerFrame } from "../frames.ts";
import { recordUsage } from "../plan-limits.ts";

/** Placeholder origin the SDK transport points at; never actually dialed. */
export const HOSTED_MCP_URL = "http://mcp-hosted.internal/mcp";

// The runner fetches at the start of a 35s-bounded invocation, so the grant
// only has to outlive a cold start.
const BUNDLE_URL_TTL_SECONDS = 120;
// Matches the Lambda client's requestTimeout below.
const CLOUDFLARE_REQUEST_TIMEOUT_MS = 45_000;
// Enough of a refusal's body to name its cause (bad origin, bad batch).
const CLOUDFLARE_ERROR_BODY_CHARS = 512;
// The Worker's answer for a bundle that cannot load there.
const WORKER_UNLOADABLE_STATUS = 422;
// How long such a bundle goes straight to Lambda. Content-addressed, so the
// wait only lets a transient load failure (a bundle download) clear.
const WORKER_UNLOADABLE_TTL_MS = 10 * 60_000;

// The parallel calls of one model step arrive well under 1ms apart; the window
// only has to outlast that. The cap bounds what one batch's shared deadline,
// output limit, and single vCPU absorb; 1 turns batching off.
const DEFAULT_BATCH_WINDOW_MS = 10;
const DEFAULT_BATCH_MAX = 8;

let sharedClient: LambdaClient | undefined;
let sendOverride: HostedMcpSendBatch | null = null;
const openBatches = new Map<string, OpenBatch>();
// accountId:sha256 of bundles the Worker could not load, to when that expires.
const unloadableOnWorker = new Map<string, number>();

/**
 * The Worker could not load the bundle, was down or was never reached, so no
 * tenant code ran there and sendBatch may run the same batch on Lambda.
 * `status` is the Worker's answer, absent when it was never reached.
 */
class WorkerNotRunError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** Streams one runtime's frames for a batch into the queue. */
type BatchDrain = (
  queue: FrameQueue,
  onInvoked: (startedAt: number) => void,
) => Promise<void>;

/** A hosted row whose bundle upload completed. */
type HostedBundleRecord = McpRecord & {
  bundleStorageKey: string;
  sha256: string;
};

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
 * `accountId` + `expectedSha256` key the handler's warm-child reuse (#189),
 * and the Cloudflare runtime's isolate cache. Both runtimes take this body.
 */
export interface McpHostPayload {
  mode: "mcp";
  toolName: string;
  accountId: string;
  expectedSha256: string;
  bundleUrl: string;
  requests: HostedMcpBatchRequest[];
}

/** A batch's outcome by request id, plus the CPU the whole batch burned. */
export interface HostedMcpBatchResult {
  outcomes: Map<string, HostedMcpResponse | Error>;
  cpuUsec: number | undefined;
}

/** What the frame stream yielded; `ended` is false when it closed without a terminal frame. */
export interface CollectedBatch {
  result: HostedMcpBatchResult;
  ended: boolean;
}

interface PendingCall {
  request: HostedMcpRequest;
  abortSignal: AbortSignal;
  onCpuUsec: ((cpuUsec: number) => void) | undefined;
  resolve: (response: HostedMcpResponse) => void;
  reject: (error: unknown) => void;
}

interface OpenBatch {
  record: HostedBundleRecord;
  calls: PendingCall[];
  timer: ReturnType<typeof setTimeout>;
}

type HostedMcpSendBatch = (
  record: HostedBundleRecord,
  requests: HostedMcpBatchRequest[],
  abortSignal: AbortSignal,
) => Promise<HostedMcpBatchResult>;

/**
 * Fold a batch's frames into per-request outcomes. A tagged final or error
 * settles its request; `end` closes the batch; an untagged error closes it
 * and fails every request still unanswered.
 */
export async function collectBatchFrames(
  serverName: string,
  requests: HostedMcpBatchRequest[],
  frames: AsyncIterable<RunnerFrame>,
): Promise<CollectedBatch> {
  const result: HostedMcpBatchResult = {
    outcomes: new Map(),
    cpuUsec: undefined,
  };
  const runFailed = (message: string): Error =>
    new Error(message || `hosted MCP server ${serverName} run failed`);
  let ended = false;
  for await (const frame of frames) {
    if (frame.t === "final" && frame.id !== undefined) {
      try {
        result.outcomes.set(
          frame.id,
          finalHostedResponse(serverName, frame.result),
        );
      } catch (error) {
        result.outcomes.set(frame.id, error as Error);
      }
    } else if (frame.t === "error" && frame.id !== undefined) {
      result.outcomes.set(frame.id, runFailed(frame.error));
    } else if (frame.t === "end" || frame.t === "error") {
      result.cpuUsec = frame.cpuUsec;
      ended = true;
      if (frame.t === "error") {
        const batchError = runFailed(frame.error);
        for (const request of requests) {
          if (!result.outcomes.has(request.id)) {
            result.outcomes.set(request.id, batchError);
          }
        }
      }
      break;
    }
  }

  return { result: result, ended: ended };
}

/**
 * A FetchLike for the SDK's StreamableHTTPClientTransport that routes every
 * request through the Lambda host instead of the network. onCpuUsec reports
 * this call's share of its batch's CPU for usage metering.
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
    // modern, which never opens it, so refuse it outright as the spec allows.
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

/** Tests and the local stack: answer whole batches locally. null also drops open batches. */
export function setHostedMcpSendBatchForTests(
  send: HostedMcpSendBatch | null,
): void {
  sendOverride = send;
  for (const batch of openBatches.values()) clearTimeout(batch.timer);
  openBatches.clear();
  unloadableOnWorker.clear();
}

// One tenant bundle: the Worker's loader id and the unloadable cache key.
function bundleKey(record: McpRecord): string {
  return `${record.accountId}:${record.sha256}`;
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

// POST the batch to the Cloudflare runtime and push its NDJSON body into the
// queue as it arrives. Throws WorkerNotRunError when the Worker ran nothing for
// a reason Lambda would not share, so sendBatch can retry there; a timeout or
// abort after sending is metered.
async function drainBridgeStream(
  url: string,
  payload: McpHostPayload,
  abortSignal: AbortSignal,
  queue: FrameQueue,
  onInvoked: (startedAt: number) => void,
): Promise<void> {
  const apiKey = requireEnv("CLOUDFLARE_MCP_API_KEY");
  const startedAt = Date.now();
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
    redirect: "error",
    signal: AbortSignal.any([
      abortSignal,
      AbortSignal.timeout(CLOUDFLARE_REQUEST_TIMEOUT_MS),
    ]),
  }).catch((error: unknown): never => {
    if (
      error instanceof DOMException &&
      (error.name === "TimeoutError" || error.name === "AbortError")
    ) {
      onInvoked(startedAt);
    }
    if (isUnreachableError(error)) {
      throw new WorkerNotRunError(
        `cloudflare MCP runtime unreachable: ${toErrorMessage(error)}`,
      );
    }
    throw error;
  });
  if (!response.ok) {
    const reason = (await response.text()).slice(
      0,
      CLOUDFLARE_ERROR_BODY_CHARS,
    );
    const message = `cloudflare MCP runtime failed with HTTP ${response.status}${reason ? `: ${reason}` : ""}`;
    // A bundle that cannot load there, or an outage (502 and up, a load
    // timeout included), ran nothing and may rerun on Lambda. A 401, a 400 or
    // the Worker's own 500 is a misconfiguration and fails loudly.
    if (
      response.status === WORKER_UNLOADABLE_STATUS ||
      response.status >= 502
    ) {
      throw new WorkerNotRunError(message, response.status);
    }
    throw new Error(message);
  }
  if (!response.body) {
    throw new Error("cloudflare MCP runtime answered with no body");
  }
  onInvoked(startedAt);
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    queue.push(decoder.decode(chunk, { stream: true }));
  }
  queue.push(decoder.decode());
}

// Invoke the runner Lambda and push its raw NDJSON payload chunks into the queue
// as they arrive. Surfaces a Lambda-side failure (InvokeComplete.ErrorCode) as a
// thrown error; server-side failures arrive as an `error` frame instead.
async function drainInvokeStream(
  client: LambdaClient,
  payload: McpHostPayload,
  abortSignal: AbortSignal,
  queue: FrameQueue,
  onInvoked: (startedAt: number) => void,
): Promise<void> {
  const result = await client.send(
    new InvokeWithResponseStreamCommand({
      FunctionName: requireEnv("TOOL_RUNNER_FUNCTION_NAME"),
      InvocationType: "RequestResponse",
      // A PER_TENANT function refuses an invoke without a tenant id, and any
      // other function refuses one with it. Off by default, matching the SST
      // deploy; set MCP_TENANT_ISOLATION=true on both sides together.
      ...(booleanEnv("MCP_TENANT_ISOLATION", false)
        ? { TenantId: payload.accountId }
        : {}),
      Payload: new TextEncoder().encode(JSON.stringify(payload)),
    }),
    { abortSignal: abortSignal },
  );
  onInvoked(Date.now());
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

// Park a call in the open batch for its tenant bundle; the window or the cap
// flushes it. A call that misses the window opens the next batch.
function enqueueCall(
  record: McpRecord,
  request: HostedMcpRequest,
  abortSignal: AbortSignal,
  onCpuUsec: ((cpuUsec: number) => void) | undefined,
): Promise<HostedMcpResponse> {
  if (!hasBundle(record)) {
    return Promise.reject(
      new Error(
        `hosted MCP server ${record.name} is missing its uploaded bundle`,
      ),
    );
  }
  if (abortSignal.aborted) return Promise.reject(abortSignal.reason);
  const { promise, resolve, reject } =
    Promise.withResolvers<HostedMcpResponse>();
  abortSignal.addEventListener("abort", () => reject(abortSignal.reason), {
    once: true,
  });
  const key = `${record.accountId}:${workersUrl(record) ?? "lambda"}:${record.sha256}`;
  let batch = openBatches.get(key);
  if (!batch) {
    const opened: OpenBatch = {
      record: record,
      calls: [],
      timer: setTimeout(
        () => flushBatch(key, opened),
        positiveIntegerEnv("MCP_BATCH_WINDOW_MS", DEFAULT_BATCH_WINDOW_MS),
      ),
    };
    openBatches.set(key, opened);
    batch = opened;
  }
  batch.calls.push({
    request: request,
    abortSignal: abortSignal,
    onCpuUsec: onCpuUsec,
    resolve: resolve,
    reject: reject,
  });
  if (
    batch.calls.length >= positiveIntegerEnv("MCP_BATCH_MAX", DEFAULT_BATCH_MAX)
  ) {
    flushBatch(key, batch);
  }

  return promise;
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

// Send the batch and settle every call still waiting on it. The invoke is
// abandoned only once every call in it has been aborted.
function flushBatch(key: string, batch: OpenBatch): void {
  openBatches.delete(key);
  clearTimeout(batch.timer);
  const live = batch.calls
    .filter((call) => !call.abortSignal.aborted)
    .map((call, index) => ({ id: String(index + 1), call: call }));
  if (live.length === 0) return;
  const controller = new AbortController();
  for (const { call } of live) {
    call.abortSignal.addEventListener(
      "abort",
      () => {
        if (live.every((member) => member.call.abortSignal.aborted)) {
          controller.abort();
        }
      },
      { once: true },
    );
  }
  const requests = live.map(({ id, call }): HostedMcpBatchRequest => ({
    id: id,
    mcpRequest: call.request,
  }));
  const send = sendOverride ?? sendBatch;
  void send(batch.record, requests, controller.signal).then(
    (result) => {
      const settled = live.filter(({ call }) => !call.abortSignal.aborted);
      // Reported before any call resolves: the harness reads a call's compute
      // the moment its result lands.
      if (
        typeof result.cpuUsec === "number" &&
        result.cpuUsec > 0 &&
        settled.length > 0
      ) {
        const share = Math.round(result.cpuUsec / settled.length);
        for (const { call } of settled) call.onCpuUsec?.(share);
      }
      for (const { id, call } of settled) {
        const outcome =
          result.outcomes.get(id) ??
          new Error(
            `hosted MCP server ${batch.record.name} returned no response`,
          );
        if (outcome instanceof Error) call.reject(outcome);
        else call.resolve(outcome);
      }
    },
    (error: unknown) => {
      for (const { call } of live) call.reject(error);
    },
  );
}

function hasBundle(record: McpRecord): record is HostedBundleRecord {
  return Boolean(record.bundleStorageKey && record.sha256);
}

// Collect one runtime's frames for the batch and meter what it ran.
async function runBatch(
  record: HostedBundleRecord,
  requests: HostedMcpBatchRequest[],
  drain: BatchDrain,
): Promise<HostedMcpBatchResult> {
  const queue = new FrameQueue();
  let transportError: unknown;
  // When the batch got underway. A failure before that (no function
  // name, a refused or throttled request) runs nothing and costs nothing.
  let invokedAt: number | undefined;
  const pump = drain(queue, (startedAt: number): void => {
    invokedAt = startedAt;
  })
    .catch((error: unknown) => {
      transportError = error;
    })
    .finally(() => queue.close());
  try {
    const collected = await collectBatchFrames(
      record.name,
      requests,
      queue.frames(),
    );
    // A transport failure after the child's own terminal frame is noise; the
    // child's answer stands. A stream that closed without one is truncated.
    if (!collected.ended) {
      throw (
        transportError ??
        new Error(
          `hosted MCP server ${record.name} stream closed without an end frame`,
        )
      );
    }

    return collected.result;
  } finally {
    await pump;
    // Lambda bills the invoke's wall time at the function's memory size.
    // Cloudflare is metered the same way, so the tariff does not depend on
    // which runtime a row picked.
    if (invokedAt !== undefined) {
      recordUsage(record.accountId, {
        hostedMcpGbSeconds:
          ((Date.now() - invokedAt) / 1000) * HOSTED_MCP_MEMORY_GB,
        hostedMcpRequests: 1,
      });
    }
  }
}

// One invoke for one batch, on the row's runtime; a transport failure before
// any terminal frame throws for every call. A Worker that ran nothing hands
// the same batch to Lambda, so a broken Worker degrades instead of failing.
async function sendBatch(
  record: HostedBundleRecord,
  requests: HostedMcpBatchRequest[],
  abortSignal: AbortSignal,
): Promise<HostedMcpBatchResult> {
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
    requests: requests,
  };
  const bridgeUrl = workersUrl(record);
  if (!bridgeUrl) {
    return await runBatch(record, requests, (queue, onInvoked): Promise<void> =>
      drainInvokeStream(
        defaultClient(),
        payload,
        abortSignal,
        queue,
        onInvoked,
      ),
    );
  }
  try {
    return await runBatch(record, requests, (queue, onInvoked): Promise<void> =>
      drainBridgeStream(bridgeUrl, payload, abortSignal, queue, onInvoked),
    );
  } catch (error) {
    if (!(error instanceof WorkerNotRunError)) throw error;
    if (error.status === WORKER_UNLOADABLE_STATUS) {
      unloadableOnWorker.set(
        bundleKey(record),
        Date.now() + WORKER_UNLOADABLE_TTL_MS,
      );
    }
    logWarn("hosted MCP batch fell back to Lambda", {
      accountId: record.accountId,
      server: record.name,
      reason: error.message,
    });

    return await runBatch(record, requests, (queue, onInvoked): Promise<void> =>
      drainInvokeStream(
        defaultClient(),
        payload,
        abortSignal,
        queue,
        onInvoked,
      ),
    ).catch((lambdaError: unknown): never => {
      throw new Error(
        `${toErrorMessage(lambdaError)} (Lambda fallback after: ${error.message})`,
        { cause: lambdaError },
      );
    });
  }
}

// The Worker's URL when the owner left the runtime on "auto", the bundle can
// run on Workers, this deployment runs the Worker (URL and key both set), and
// the Worker has not lately failed to load it; undefined sends it to Lambda.
function workersUrl(record: McpRecord): string | undefined {
  const unloadableUntil = unloadableOnWorker.get(bundleKey(record));
  if (unloadableUntil !== undefined && unloadableUntil > Date.now()) {
    return undefined;
  }
  if (unloadableUntil !== undefined)
    unloadableOnWorker.delete(bundleKey(record));

  return record.runtime !== "lambda" &&
    record.workersCompatible &&
    optionalEnv("CLOUDFLARE_MCP_API_KEY")
    ? optionalEnv("CLOUDFLARE_MCP_URL")
    : undefined;
}
