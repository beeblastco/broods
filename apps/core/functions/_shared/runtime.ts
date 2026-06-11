/**
 * Shared Bun runtime bridge.
 * Keep Lambda Runtime API polling and HTTP response streaming here.
 */

export interface LambdaInvocation {
  requestId: string;
  functionArn: string;
  traceId: string;
  deadlineMs: number;
}

export interface LambdaResponse {
  statusCode?: number;
  headers?: Record<string, string>;
  cookies?: string[];
  body?: string | Uint8Array | ReadableStream<Uint8Array>;
  afterResponse?: Promise<void>;
}

export type StreamingLambdaHandler<TPayload = unknown> = (
  payload: TPayload,
  context: LambdaInvocation,
) => Promise<LambdaResponse>;

const HTTP_INTEGRATION_CONTENT_TYPE = "application/vnd.awslambda.http-integration-response";
const NULL_SEPARATOR = new Uint8Array(8);
const textEncoder = new TextEncoder();

interface RuntimeDependencies {
  fetchImpl?: typeof fetch;
  runtimeApi?: string;
}

function parseInvocationHeaders(res: Response): { requestId: string; context: LambdaInvocation } {
  const requestId = res.headers.get("lambda-runtime-aws-request-id")!;
  return {
    requestId,
    context: {
      requestId,
      functionArn: res.headers.get("lambda-runtime-invoked-functionarn") ?? "",
      traceId: res.headers.get("lambda-runtime-trace-id") ?? "",
      deadlineMs: Number(res.headers.get("lambda-runtime-deadline-ms") ?? "0"),
    },
  };
}

async function reportError(
  requestId: string,
  err: unknown,
  dependencies: RuntimeDependencies = {},
): Promise<void> {
  const error = err instanceof Error ? err : new Error(String(err));
  await resolveFetch(dependencies)(
    `${runtimeBaseUrl(dependencies)}/2018-06-01/runtime/invocation/${requestId}/error`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        errorMessage: error.message,
        errorType: error.name,
        stackTrace: error.stack?.split("\n"),
      }),
    },
  );
}

export async function processNextRuntimeInvocation<TPayload>(
  handler: StreamingLambdaHandler<TPayload>,
  dependencies: RuntimeDependencies = {},
): Promise<void> {
  const res = await resolveFetch(dependencies)(`${runtimeBaseUrl(dependencies)}/2018-06-01/runtime/invocation/next`);
  const { requestId, context } = parseInvocationHeaders(res);
  const payloadText = await res.text();

  let payload: TPayload;
  try {
    payload = JSON.parse(payloadText) as TPayload;
  } catch (parseErr) {
    await reportError(requestId, new Error(`Invalid JSON: ${parseErr}`), dependencies);
    return;
  }

  try {
    const response = await handler(payload, context);
    await resolveFetch(dependencies)(
      `${runtimeBaseUrl(dependencies)}/2018-06-01/runtime/invocation/${requestId}/response`,
      {
        method: "POST",
        headers: {
          "Content-Type": HTTP_INTEGRATION_CONTENT_TYPE,
          "Lambda-Runtime-Function-Response-Mode": "streaming",
          "Transfer-Encoding": "chunked",
        },
        body: encodeResponse(response),
        duplex: "half",
      },
    );
    await response.afterResponse;
  } catch (err: unknown) {
    await reportError(requestId, err, dependencies);
  }
}

export async function startStreamingRuntime<TPayload>(
  handler: StreamingLambdaHandler<TPayload>,
): Promise<never> {
  for (; ;) {
    await processNextRuntimeInvocation(handler);
  }
}

export function encodeResponse(response: LambdaResponse): ReadableStream<Uint8Array> {
  const metadata = {
    statusCode: response.statusCode ?? 200,
    headers: response.headers ?? {},
    ...(response.cookies && response.cookies.length > 0 ? { cookies: response.cookies } : {}),
  };

  return concatStreams(
    streamFromBytes(textEncoder.encode(JSON.stringify(metadata))),
    streamFromBytes(NULL_SEPARATOR),
    toBodyStream(response.body),
  );
}

function toBodyStream(
  body: LambdaResponse["body"],
): ReadableStream<Uint8Array> {
  if (!body) {
    return new ReadableStream({
      start(controller) {
        controller.close();
      },
    });
  }

  if (typeof body === "string") {
    return streamFromBytes(textEncoder.encode(body));
  }

  if (body instanceof Uint8Array) {
    return streamFromBytes(body);
  }

  return body;
}

function streamFromBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function resolveFetch(dependencies: RuntimeDependencies): typeof fetch {
  return dependencies.fetchImpl ?? fetch;
}

function runtimeBaseUrl(dependencies: RuntimeDependencies): string {
  const runtimeApi = dependencies.runtimeApi ?? process.env.AWS_LAMBDA_RUNTIME_API;
  if (!runtimeApi) {
    throw new Error("Missing required environment variable: AWS_LAMBDA_RUNTIME_API");
  }

  return `http://${runtimeApi}`;
}

function concatStreams(
  ...streams: ReadableStream<Uint8Array>[]
): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async start(controller) {
      try {
        for (const stream of streams) {
          const reader = stream.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) controller.enqueue(value);
          }
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });
}
