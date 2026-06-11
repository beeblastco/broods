/**
 * Runtime bridge tests.
 * Cover Lambda Runtime API polling, error reporting, and response encoding here.
 */

import { describe, expect, it, mock } from "bun:test";
import {
  encodeResponse,
  processNextRuntimeInvocation,
} from "../functions/_shared/runtime.ts";

describe("runtime bridge", () => {
  it("encodes default metadata and string bodies", async () => {
    const bytes = await readStream(
      encodeResponse({
        body: "hello",
      }),
    );

    const { metadata, bodyText } = splitEncodedResponse(bytes);
    expect(metadata).toEqual({
      statusCode: 200,
      headers: {},
    });
    expect(bodyText).toBe("hello");
  });

  it("encodes cookies and binary or streamed bodies", async () => {
    const binaryBytes = await readStream(
      encodeResponse({
        statusCode: 201,
        headers: { "Content-Type": "application/octet-stream" },
        cookies: ["a=1", "b=2"],
        body: new Uint8Array([1, 2, 3]),
      }),
    );

    const binaryParts = splitEncodedResponse(binaryBytes);
    expect(binaryParts.metadata).toEqual({
      statusCode: 201,
      headers: { "Content-Type": "application/octet-stream" },
      cookies: ["a=1", "b=2"],
    });
    expect([...binaryParts.bodyBytes]).toEqual([1, 2, 3]);

    const streamedBytes = await readStream(
      encodeResponse({
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("abc"));
            controller.close();
          },
        }),
      }),
    );

    const streamedParts = splitEncodedResponse(streamedBytes);
    expect(streamedParts.metadata).toEqual({
      statusCode: 200,
      headers: {},
    });
    expect(streamedParts.bodyText).toBe("abc");
  });

  it("reports invalid invocation JSON to the runtime error endpoint", async () => {
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = mock(async (url: string | URL, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init });

      if (fetchCalls.length === 1) {
        return createInvocationResponse("not-json", "req-1");
      }

      return new Response("ok", { status: 202 });
    });

    const handler = mock(async () => ({
      statusCode: 200,
    }));

    await processNextRuntimeInvocation(handler, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      runtimeApi: "runtime.local",
    });

    expect(handler).not.toHaveBeenCalled();
    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls[1]?.url).toBe("http://runtime.local/2018-06-01/runtime/invocation/req-1/error");
    const body = JSON.parse(String(fetchCalls[1]?.init?.body));
    expect(body.errorMessage).toContain("Invalid JSON");
  });

  it("posts encoded responses and awaits afterResponse", async () => {
    const order: string[] = [];
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    let resolveAfterResponse!: () => void;

    const fetchImpl = mock(async (url: string | URL, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init });

      if (fetchCalls.length === 1) {
        return createInvocationResponse(JSON.stringify({ ok: true }), "req-2");
      }

      order.push("response-posted");
      resolveAfterResponse();
      return new Response("ok", { status: 202 });
    });

    const handler = mock(async (payload: { ok: boolean }) => {
      order.push(`handler:${payload.ok}`);

      return {
        statusCode: 202,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
        body: "done",
        afterResponse: new Promise<void>((resolve) => {
          resolveAfterResponse = () => {
            order.push("after-response");
            resolve();
          };
        }),
      };
    });

    await processNextRuntimeInvocation(handler, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      runtimeApi: "runtime.local",
    });

    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls[1]?.url).toBe("http://runtime.local/2018-06-01/runtime/invocation/req-2/response");
    const encoded = await readRequestBody(fetchCalls[1]?.init?.body);
    const { metadata, bodyText } = splitEncodedResponse(encoded);
    expect(metadata).toEqual({
      statusCode: 202,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
    expect(bodyText).toBe("done");
    expect(order).toEqual([
      "handler:true",
      "response-posted",
      "after-response",
    ]);
  });

  it("reports handler failures to the runtime error endpoint", async () => {
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = mock(async (url: string | URL, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init });

      if (fetchCalls.length === 1) {
        return createInvocationResponse(JSON.stringify({ ok: true }), "req-3");
      }

      return new Response("ok", { status: 202 });
    });

    await processNextRuntimeInvocation(async () => {
      throw new Error("boom");
    }, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      runtimeApi: "runtime.local",
    });

    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls[1]?.url).toBe("http://runtime.local/2018-06-01/runtime/invocation/req-3/error");
    const body = JSON.parse(String(fetchCalls[1]?.init?.body));
    expect(body.errorMessage).toBe("boom");
    expect(body.errorType).toBe("Error");
  });
});

function createInvocationResponse(body: string, requestId: string): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "lambda-runtime-aws-request-id": requestId,
      "lambda-runtime-invoked-functionarn": "arn:aws:lambda:region:acct:function:test",
      "lambda-runtime-trace-id": "trace-id",
      "lambda-runtime-deadline-ms": "12345",
    },
  });
}

async function readRequestBody(body: RequestInit["body"] | null | undefined): Promise<Uint8Array> {
  if (body == null) {
    return new Uint8Array();
  }

  if (typeof body === "string") {
    return new TextEncoder().encode(body);
  }

  if (body instanceof Uint8Array) {
    return body;
  }

  if (body instanceof ReadableStream) {
    return readStream(body);
  }

  return new Uint8Array(await new Response(body).arrayBuffer());
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    if (value) {
      chunks.push(value);
    }
  }

  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }

  return merged;
}

function splitEncodedResponse(bytes: Uint8Array): {
  metadata: Record<string, unknown>;
  bodyBytes: Uint8Array;
  bodyText: string;
} {
  const separatorIndex = findNullSeparator(bytes);
  if (separatorIndex < 0) {
    throw new Error("Expected encoded response to contain the Lambda null separator");
  }

  const metadataBytes = bytes.slice(0, separatorIndex);
  const bodyBytes = bytes.slice(separatorIndex + 8);

  return {
    metadata: JSON.parse(new TextDecoder().decode(metadataBytes)) as Record<string, unknown>,
    bodyBytes,
    bodyText: new TextDecoder().decode(bodyBytes),
  };
}

function findNullSeparator(bytes: Uint8Array): number {
  for (let index = 0; index <= bytes.length - 8; index += 1) {
    let allZero = true;
    for (let offset = 0; offset < 8; offset += 1) {
      if (bytes[index + offset] !== 0) {
        allZero = false;
        break;
      }
    }

    if (allZero) {
      return index;
    }
  }

  return -1;
}
