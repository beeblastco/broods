/**
 * Hosted MCP server transport (#331 phase 2). A hosted row's endpoint is the
 * tool-runner Lambda: this fetch adapter serializes one web request into an
 * mcp-mode runner payload, invokes the Lambda through the shared tool-runner
 * client and frame reader (bundles/executor.ts, bundles/payload.ts), and
 * rebuilds the child's serialized response. Stateless: one invoke per
 * request, matching the 2026-07-28 transport exactly.
 */

import type { McpRecord } from "../../shared/domain/mcp.ts";
import { defaultClient, drainInvokeStream } from "../bundles/executor.ts";
import {
  BUNDLE_URL_TTL_SECONDS,
  FrameQueue,
  toolBundlesBucket,
} from "../bundles/payload.ts";
import { getS3ObjectUrl } from "../../shared/s3.ts";

/** Placeholder origin the SDK transport points at; never actually dialed. */
export const HOSTED_MCP_URL = "http://mcp-hosted.internal/mcp";

/** One serialized web request, as the mcp-mode child receives it. */
interface HostedMcpRequest {
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

interface HostedMcpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

type HostedMcpInvoke = (
  record: McpRecord,
  request: HostedMcpRequest,
  abortSignal: AbortSignal | undefined,
) => Promise<HostedMcpResponse>;

let invokeOverride: HostedMcpInvoke | null = null;

/**
 * A FetchLike for the SDK's StreamableHTTPClientTransport that routes every
 * request through the Lambda host instead of the network.
 */
export function hostedMcpFetch(record: McpRecord): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input as never, init);
    const body = request.method === "GET" ? undefined : await request.text();
    const invoke = invokeOverride ?? invokeLambda;
    const result = await invoke(
      record,
      {
        method: request.method,
        headers: Object.fromEntries(request.headers),
        body: body,
      },
      request.signal,
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

async function invokeLambda(
  record: McpRecord,
  request: HostedMcpRequest,
  abortSignal: AbortSignal | undefined,
): Promise<HostedMcpResponse> {
  if (!record.bundleStorageKey || !record.sha256) {
    throw new Error(
      `hosted MCP server ${record.name} is missing its uploaded bundle`,
    );
  }
  const payload = {
    mode: "mcp",
    toolName: record.name,
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
  try {
    for await (const frame of queue.frames()) {
      if (frame.t === "error") {
        throw new Error(
          frame.error || `hosted MCP server ${record.name} run failed`,
        );
      }
      if (frame.t === "final") {
        return finalHostedResponse(record.name, frame.result);
      }
    }
  } finally {
    await pump;
  }
  if (transportError) throw transportError;

  throw new Error(`hosted MCP server ${record.name} returned no response`);
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
