/**
 * Hosted MCP server transport (#331 phase 2). A hosted row's endpoint is the
 * tool-runner Lambda: this fetch adapter serializes one web request into an
 * mcp-mode runner payload, invokes the Lambda over InvokeWithResponseStream,
 * and rebuilds the child's serialized response. Stateless: one invoke per
 * request, matching the 2026-07-28 transport exactly.
 */

import {
  InvokeWithResponseStreamCommand,
  LambdaClient,
} from "@aws-sdk/client-lambda";
import { requireEnv } from "../../shared/env.ts";
import type { McpRecord } from "../../shared/domain/mcp.ts";
import { parseToolRunnerFrame, toolBundlesBucket } from "../bundles/payload.ts";
import { getS3ObjectUrl } from "../../shared/s3.ts";

/** Placeholder origin the SDK transport points at; never actually dialed. */
export const HOSTED_MCP_URL = "http://mcp-hosted.internal/mcp";

interface HostedMcpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

type HostedMcpInvoke = (
  record: McpRecord,
  request: {
    method: string;
    headers: Record<string, string>;
    body: string | undefined;
  },
) => Promise<HostedMcpResponse>;

let invokeOverride: HostedMcpInvoke | null = null;
let sharedClient: LambdaClient | undefined;

/**
 * A FetchLike for the SDK's StreamableHTTPClientTransport that routes every
 * request through the Lambda host instead of the network.
 */
export function hostedMcpFetch(record: McpRecord): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input as never, init);
    const body = request.method === "GET" ? undefined : await request.text();
    const headers: Record<string, string> = {};
    request.headers.forEach((value, name) => {
      headers[name] = value;
    });
    const invoke = invokeOverride ?? invokeLambda;
    const result = await invoke(record, {
      method: request.method,
      headers: headers,
      body: body,
    });

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
  request: {
    method: string;
    headers: Record<string, string>;
    body: string | undefined;
  },
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
      { expiresInSeconds: 60 },
    ),
    mcpRequest: request,
  };
  const client = (sharedClient ??= new LambdaClient({
    requestHandler: { connectionTimeout: 5_000, requestTimeout: 45_000 },
  }));
  const result = await client.send(
    new InvokeWithResponseStreamCommand({
      FunctionName: requireEnv("TOOL_RUNNER_FUNCTION_NAME"),
      InvocationType: "RequestResponse",
      Payload: new TextEncoder().encode(JSON.stringify(payload)),
    }),
  );
  const decoder = new TextDecoder();
  let output = "";
  for await (const event of result.EventStream ?? []) {
    const chunk = event.PayloadChunk?.Payload;
    if (chunk) {
      output += decoder.decode(chunk, { stream: true });
      continue;
    }
    const errorCode = event.InvokeComplete?.ErrorCode;
    if (errorCode) {
      throw new Error(
        `mcp host Lambda failed: ${event.InvokeComplete?.ErrorDetails || errorCode}`,
      );
    }
  }
  output += decoder.decode();

  return finalResponseFromFrames(record.name, output);
}

/** The child answers with one terminal frame carrying the serialized response. */
function finalResponseFromFrames(
  serverName: string,
  output: string,
): HostedMcpResponse {
  for (const line of output.split("\n")) {
    const frame = parseToolRunnerFrame(line);
    if (!frame) continue;
    if (frame.t === "error") {
      throw new Error(
        frame.error || `hosted MCP server ${serverName} run failed`,
      );
    }
    if (frame.t === "final") {
      const result = frame.result as HostedMcpResponse | undefined;
      if (
        !result ||
        typeof result.status !== "number" ||
        typeof result.body !== "string"
      ) {
        throw new Error(
          `hosted MCP server ${serverName} returned a malformed response`,
        );
      }

      return result;
    }
  }

  throw new Error(`hosted MCP server ${serverName} returned no response`);
}
