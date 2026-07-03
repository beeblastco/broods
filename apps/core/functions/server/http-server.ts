/**
 * Container HTTP bridge for the self-hosted core runtime (epic #85 phase 9a).
 * Maps plain HTTP requests onto the Lambda Function URL event shape both
 * handlers already speak and streams LambdaResponse bodies back (SSE included).
 * Lambda-specific runtime wiring stays in functions/_shared/runtime.ts.
 */

import type { LambdaFunctionURLEvent } from "aws-lambda";
import { logError } from "../_shared/log.ts";
import type { LambdaInvocation, LambdaResponse } from "../_shared/runtime.ts";

export type CoreHandler = (
  event: LambdaFunctionURLEvent,
  context?: LambdaInvocation,
) => Promise<LambdaResponse>;

export interface CoreServerOptions {
  harnessHandler: CoreHandler;
  accountHandler: CoreHandler;
  /** Hostnames (lowercase, no port) served by the account-manage handler. */
  accountManageHosts: string[];
  /** Synthesized invocation deadline; matches the 10-minute Lambda timeout. */
  requestBudgetMs?: number;
  port: number;
  hostname?: string;
}

export interface CoreServer {
  server: ReturnType<typeof Bun.serve>;
  /** Settles once all tracked post-response work (afterResponse) finishes. */
  drain: () => Promise<void>;
}

const DEFAULT_REQUEST_BUDGET_MS = 10 * 60 * 1000;

export function createCoreServer(options: CoreServerOptions): CoreServer {
  const accountHosts = new Set(options.accountManageHosts.map((host) => host.trim().toLowerCase()).filter(Boolean));
  const requestBudgetMs = options.requestBudgetMs ?? DEFAULT_REQUEST_BUDGET_MS;
  const inFlight = new Set<Promise<void>>();

  const track = (promise: Promise<void>): void => {
    const tracked = promise
      .catch((err) => {
        logError("Post-response work failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        inFlight.delete(tracked);
      });
    inFlight.add(tracked);
  };

  const server = Bun.serve({
    port: options.port,
    hostname: options.hostname ?? "0.0.0.0",
    // SSE streams can have long quiet gaps; Bun's 10s default would kill them.
    idleTimeout: 0,
    fetch: async (request, bunServer) => {
      const url = new URL(request.url);
      if (url.pathname === "/healthz" && request.method === "GET") {
        return Response.json({ status: "ok" });
      }

      const event = await synthesizeEvent(request, url, bunServer.requestIP(request)?.address);
      const context: LambdaInvocation = {
        requestId: event.requestContext.requestId,
        functionArn: "",
        traceId: "",
        deadlineMs: Date.now() + requestBudgetMs,
      };
      const host = event.requestContext.domainName;
      const handle = accountHosts.has(host) ? options.accountHandler : options.harnessHandler;

      let response: LambdaResponse;
      try {
        response = await handle(event, context);
      } catch (err) {
        logError("Core server handler failed", {
          path: url.pathname,
          host,
          error: err instanceof Error ? err.message : String(err),
        });
        return Response.json({ error: "Internal server error" }, { status: 500 });
      }

      return toHttpResponse(response, track);
    },
  });

  return {
    server,
    drain: async () => {
      while (inFlight.size > 0) {
        await Promise.allSettled([...inFlight]);
      }
    },
  };
}

async function synthesizeEvent(
  request: Request,
  url: URL,
  socketAddress: string | undefined,
): Promise<LambdaFunctionURLEvent> {
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });

  const bodyBytes = new Uint8Array(await request.arrayBuffer());
  const host = (headers["host"] ?? url.hostname).split(":")[0]!.toLowerCase();
  const forwardedFor = headers["x-forwarded-for"]?.split(",")[0]?.trim();
  const now = Date.now();
  const requestId = crypto.randomUUID();

  const queryStringParameters: Record<string, string> = {};
  url.searchParams.forEach((value, key) => {
    queryStringParameters[key] = value;
  });

  // Function URL events deliver cookies as a dedicated array (payload v2.0).
  const cookies = headers["cookie"]
    ?.split(";")
    .map((cookie) => cookie.trim())
    .filter(Boolean);

  return {
    version: "2.0",
    routeKey: "$default",
    rawPath: url.pathname,
    rawQueryString: url.search.startsWith("?") ? url.search.slice(1) : url.search,
    headers,
    ...(cookies && cookies.length > 0 ? { cookies } : {}),
    ...(url.searchParams.size > 0 ? { queryStringParameters } : {}),
    requestContext: {
      accountId: "anonymous",
      apiId: "self-hosted",
      domainName: host,
      domainPrefix: host.split(".")[0] ?? host,
      http: {
        method: request.method,
        path: url.pathname,
        protocol: "HTTP/1.1",
        sourceIp: forwardedFor || socketAddress || "",
        userAgent: headers["user-agent"] ?? "",
      },
      requestId,
      routeKey: "$default",
      stage: "$default",
      time: new Date(now).toISOString(),
      timeEpoch: now,
    },
    // Base64 keeps webhook payloads byte-exact for HMAC signature checks.
    ...(bodyBytes.length > 0
      ? { body: Buffer.from(bodyBytes).toString("base64"), isBase64Encoded: true }
      : { isBase64Encoded: false }),
  };
}

function toHttpResponse(response: LambdaResponse, track: (promise: Promise<void>) => void): Response {
  const headers = new Headers(response.headers ?? {});
  for (const cookie of response.cookies ?? []) {
    headers.append("set-cookie", cookie);
  }

  let body = response.body ?? null;
  if (response.afterResponse) {
    const after = response.afterResponse;
    if (body instanceof ReadableStream) {
      // Mirror the Lambda runtime ordering: post-response work starts once the
      // body has fully flushed, and shutdown waits for it via drain().
      const [tapped, flushed] = tapStream(body);
      body = tapped;
      track(flushed.then(() => after));
    } else {
      track(after);
    }
  }

  return new Response(body, { status: response.statusCode ?? 200, headers });
}

function tapStream(source: ReadableStream<Uint8Array>): [ReadableStream<Uint8Array>, Promise<void>] {
  let settle!: () => void;
  const flushed = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const reader = source.getReader();

  // Pull-based so a slow client applies backpressure to the source instead of
  // buffering the whole body, and a client disconnect cancels the source.
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          settle();
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        settle();
        controller.error(err);
      }
    },
    async cancel(reason) {
      settle();
      await reader.cancel(reason);
    },
  });

  return [stream, flushed];
}
