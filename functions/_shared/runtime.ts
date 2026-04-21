// Custom Bun Lambda runtime adapters for normal request/response and streaming Function URL handlers.
export type LambdaHandler<TPayload = unknown, TResult = unknown> = (
  payload: TPayload,
  context: LambdaInvocation,
) => Promise<TResult>;

export type StreamingLambdaHandler<TPayload = unknown> = (
  payload: TPayload,
  context: LambdaInvocation,
) => Promise<ReadableStream<Uint8Array>>;

export interface LambdaInvocation {
  requestId: string;
  functionArn: string;
  traceId: string;
  deadlineMs: number;
}

const RUNTIME_API = process.env.AWS_LAMBDA_RUNTIME_API!;
const NEXT_URL = `http://${RUNTIME_API}/2018-06-01/runtime/invocation/next`;

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

async function reportError(requestId: string, err: unknown): Promise<void> {
  const error = err instanceof Error ? err : new Error(String(err));
  await fetch(
    `http://${RUNTIME_API}/2018-06-01/runtime/invocation/${requestId}/error`,
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

export async function startRuntime<TPayload, TResult>(
  handler: LambdaHandler<TPayload, TResult>,
): Promise<never> {
  for (; ;) {
    const res = await fetch(NEXT_URL);
    const { requestId, context } = parseInvocationHeaders(res);
    const payload = (await res.json()) as TPayload;

    try {
      const result = await handler(payload, context);
      await fetch(
        `http://${RUNTIME_API}/2018-06-01/runtime/invocation/${requestId}/response`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(result),
        },
      );
    } catch (err: unknown) {
      await reportError(requestId, err);
    }
  }
}

export async function startStreamingRuntime<TPayload>(
  handler: StreamingLambdaHandler<TPayload>,
): Promise<never> {
  for (; ;) {
    const res = await fetch(NEXT_URL);
    const { requestId, context } = parseInvocationHeaders(res);
    const payloadText = await res.text();

    let payload: TPayload;
    try {
      const parsed = JSON.parse(payloadText);
      if (parsed.version === "2.0" && parsed.body) {
        const bodyStr = parsed.isBase64Encoded
          ? Buffer.from(parsed.body, "base64").toString()
          : parsed.body;
        payload = JSON.parse(bodyStr) as TPayload;
      } else {
        payload = parsed as TPayload;
      }
    } catch (parseErr) {
      await reportError(requestId, new Error(`Invalid JSON: ${parseErr}`));
      continue;
    }

    try {
      const stream = await handler(payload, context);
      await fetch(
        `http://${RUNTIME_API}/2018-06-01/runtime/invocation/${requestId}/response`,
        {
          method: "POST",
          headers: {
            "Content-Type": "text/event-stream",
            "Lambda-Runtime-Function-Response-Mode": "streaming",
            "Transfer-Encoding": "chunked",
          },
          body: stream,
          duplex: "half",
        },
      );
    } catch (err: unknown) {
      await reportError(requestId, err);
    }
  }
}
