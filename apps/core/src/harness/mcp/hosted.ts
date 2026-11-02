import {
  InvokeWithResponseStreamCommand,
  LambdaClient,
} from "@aws-sdk/client-lambda";
import { HOSTED_MCP_MEMORY_GB } from "@broods/convex/model/pricing";
import type { McpRecord } from "../../shared/domain/mcp.ts";
import type { McpConnection } from "./client.ts";
import {
  booleanEnv,
  optionalEnv,
  positiveIntegerEnv,
  requireEnv,
} from "../../shared/env.ts";
import {
  isTimeoutError,
  isUnreachableError,
  toErrorMessage,
} from "../../shared/errors.ts";
import { logWarn } from "../../shared/log.ts";
import { getS3ObjectUrl } from "../../shared/s3.ts";
import { FrameQueue, toolBundlesBucket, type RunnerFrame } from "../frames.ts";
import { recordUsage } from "../plan-limits.ts";

/** Placeholder origin the SDK transport points at; never dialed. */
export const HOSTED_MCP_URL = "http://mcp-hosted.internal/mcp";

// The runner fetches the bundle as its invoke starts: the URL only has to outlive a cold start.
const BUNDLE_URL_TTL_SECONDS = 120;
// Above the runner Lambda's own 35s, so its graceful error normally wins.
const RUNNER_REQUEST_TIMEOUT_MS = 45_000;
const CLOUDFLARE_ERROR_BODY_CHARS = 512;
const WORKER_UNLOADABLE_STATUS = 422;
const WORKER_NOTHING_RAN_HEADER = "x-broods-nothing-ran";
// Bundles are content-addressed: the TTL only lets a transient load failure clear.
const WORKER_UNLOADABLE_TTL_MS = 10 * 60_000;

// One model step's parallel calls land <1ms apart; the cap bounds one invoke's deadline and vCPU.
const DEFAULT_BATCH_WINDOW_MS = 10;
const DEFAULT_BATCH_MAX = 8;

let sharedClient: LambdaClient | undefined;
let sendOverride: HostedMcpSendBatch | null = null;
const openBatches = new Map<string, OpenBatch>();
const unloadableOnWorker = new Map<string, number>();

/** No tenant code ran on the Worker, so the same batch may rerun on Lambda. */
class WorkerNotRunError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

type BatchDrain = (
  queue: FrameQueue,
  onInvoked: (startedAt: number) => void,
) => Promise<void>;

type HostedBundleRecord = McpRecord & {
  bundleStorageKey: string;
  sha256: string;
};

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

export interface HostedMcpBatchRequest {
  id: string;
  mcpRequest: HostedMcpRequest;
}

export interface McpHostPayload {
  mode: "mcp";
  toolName: string;
  tenantId: string;
  expectedSha256: string;
  bundleUrl: string;
  requests: HostedMcpBatchRequest[];
}

export interface HostedMcpBatchResult {
  outcomes: Map<string, HostedMcpResponse | Error>;
  cpuUsec: number | undefined;
}

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
  tenantId: string;
  calls: PendingCall[];
  timer: ReturnType<typeof setTimeout>;
}

type HostedMcpSendBatch = (
  batch: Pick<OpenBatch, "record" | "tenantId">,
  requests: HostedMcpBatchRequest[],
  abortSignal: AbortSignal,
) => Promise<HostedMcpBatchResult>;

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

export function hostedMcpFetch(
  connection: Pick<McpConnection, "record" | "agentId">,
  onCpuUsec?: (cpuUsec: number) => void,
): typeof fetch {
  const record = connection.record;
  const tenantId = hostedMcpTenantId(record.accountId, connection.agentId);

  return (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    // Bun's Request overloads reject the raw union; narrow the URL form first.
    const request =
      input instanceof Request
        ? new Request(input, init)
        : new Request(String(input), init);
    // A GET SSE long-poll would pin an invoke; modern rows never open it and the spec allows 405.
    if (request.method === "GET") {
      return new Response(null, { status: 405, headers: { allow: "POST" } });
    }
    const body = await request.text();
    const result = await enqueueCall(
      record,
      tenantId,
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

export function setHostedMcpSendBatchForTests(
  send: HostedMcpSendBatch | null,
): void {
  sendOverride = send;
  for (const batch of openBatches.values()) clearTimeout(batch.timer);
  openBatches.clear();
  unloadableOnWorker.clear();
}

function bundleKey(record: McpRecord): string {
  return `${record.accountId}:${record.sha256}`;
}

function defaultClient(): LambdaClient {
  sharedClient ??= new LambdaClient({
    requestHandler: {
      connectionTimeout: 5_000,
      requestTimeout: RUNNER_REQUEST_TIMEOUT_MS,
    },
  });

  return sharedClient;
}

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
      AbortSignal.timeout(RUNNER_REQUEST_TIMEOUT_MS),
    ]),
  }).catch((error: unknown): never => {
    // Sent, then timed out or aborted: the Worker may have run it, so it is metered.
    if (
      isTimeoutError(error) ||
      (error instanceof DOMException && error.name === "AbortError")
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
    // Only the Worker's own tag proves nothing ran; a status Cloudflare wrote fails loudly.
    if (response.headers.has(WORKER_NOTHING_RAN_HEADER)) {
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
      // A PER_TENANT function requires TenantId and any other refuses it: match the SST deploy.
      ...(booleanEnv("MCP_TENANT_ISOLATION", false)
        ? { TenantId: payload.tenantId }
        : {}),
      Payload: new TextEncoder().encode(JSON.stringify(payload)),
    }),
    { abortSignal: abortSignal },
  );
  onInvoked(Date.now());
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

function enqueueCall(
  record: McpRecord,
  tenantId: string,
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
  const key = `${tenantId}:${workersUrl(record) ?? "lambda"}:${record.sha256}`;
  let batch = openBatches.get(key);
  if (!batch) {
    const opened: OpenBatch = {
      record: record,
      tenantId: tenantId,
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
  void send(batch, requests, controller.signal).then(
    (result) => {
      const settled = live.filter(({ call }) => !call.abortSignal.aborted);
      // Before any resolve: the harness reads a call's compute the moment its result lands.
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

// Keys the warm child (apps/lambda/handler.mjs reuseKey), the batch and the Lambda TenantId,
// so two agents of one account never share a child or an execution environment.
function hostedMcpTenantId(
  accountId: string,
  agentId: string | undefined,
): string {
  return agentId ? `${accountId}:${agentId}` : accountId;
}

async function runBatch(
  record: HostedBundleRecord,
  requests: HostedMcpBatchRequest[],
  drain: BatchDrain,
): Promise<HostedMcpBatchResult> {
  const queue = new FrameQueue();
  let transportError: unknown;
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
    // A transport failure after the child's own terminal frame is noise: its answer stands.
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
    // Wall time at Lambda's memory size on both runtimes, so the tariff ignores the runtime.
    if (invokedAt !== undefined) {
      recordUsage(
        record.accountId,
        {
          hostedMcpGbSeconds:
            ((Date.now() - invokedAt) / 1000) * HOSTED_MCP_MEMORY_GB,
          hostedMcpRequests: 1,
        },
        { projectId: record.projectId },
      );
    }
  }
}

async function sendBatch(
  batch: Pick<OpenBatch, "record" | "tenantId">,
  requests: HostedMcpBatchRequest[],
  abortSignal: AbortSignal,
): Promise<HostedMcpBatchResult> {
  const record = batch.record;
  const payload: McpHostPayload = {
    mode: "mcp",
    toolName: record.name,
    tenantId: batch.tenantId,
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
