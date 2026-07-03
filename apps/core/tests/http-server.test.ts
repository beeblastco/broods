/**
 * Container HTTP bridge tests.
 * Cover HTTP-to-Lambda-event synthesis, host routing, SSE streaming, and
 * afterResponse ordering for the self-hosted core server here.
 */

import { afterAll, describe, expect, it } from "bun:test";
import type { LambdaFunctionURLEvent } from "aws-lambda";
import type { LambdaInvocation, LambdaResponse } from "../functions/_shared/runtime.ts";
import { createCoreServer, type CoreServer } from "../functions/server/http-server.ts";

interface CapturedInvocation {
  event: LambdaFunctionURLEvent;
  context: LambdaInvocation | undefined;
}

const captured: CapturedInvocation[] = [];
const accountCaptured: CapturedInvocation[] = [];
let harnessResponse: () => Promise<LambdaResponse> = async () => ({ statusCode: 204 });

const core: CoreServer = createCoreServer({
  harnessHandler: async (event, context) => {
    captured.push({ event, context });
    return harnessResponse();
  },
  accountHandler: async (event, context) => {
    accountCaptured.push({ event, context });
    return { statusCode: 200, body: JSON.stringify({ from: "account" }) };
  },
  accountManageHosts: ["core-account.test.broods.app"],
  requestBudgetMs: 90_000,
  port: 0,
});

const baseUrl = `http://127.0.0.1:${core.server.port}`;

afterAll(async () => {
  await core.server.stop(true);
});

function lastInvocation(): CapturedInvocation {
  const invocation = captured.at(-1);
  if (!invocation) throw new Error("No harness invocation captured");
  return invocation;
}

describe("core http server", () => {
  it("serves the health endpoint without invoking handlers", async () => {
    const before = captured.length + accountCaptured.length;
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
    expect(captured.length + accountCaptured.length).toBe(before);
  });

  it("synthesizes the Lambda Function URL event shape", async () => {
    harnessResponse = async () => ({ statusCode: 204 });
    const res = await fetch(`${baseUrl}/webhooks/acct/agent/telegram?limit=2&q=a%20b`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Custom-Header": "Value-Kept",
        "x-forwarded-for": "203.0.113.9, 10.0.0.1",
      },
      body: JSON.stringify({ hello: "world" }),
    });
    expect(res.status).toBe(204);

    const { event, context } = lastInvocation();
    expect(event.version).toBe("2.0");
    expect(event.rawPath).toBe("/webhooks/acct/agent/telegram");
    expect(event.rawQueryString).toBe("limit=2&q=a%20b");
    expect(event.queryStringParameters).toEqual({ limit: "2", q: "a b" });
    expect(event.requestContext.http.method).toBe("POST");
    // Rightmost XFF entry (the proxy-appended peer), not the spoofable leftmost.
    expect(event.requestContext.http.sourceIp).toBe("10.0.0.1");
    // Header keys are lowercased, matching the Lambda Function URL envelope.
    expect(event.headers["x-custom-header"]).toBe("Value-Kept");
    expect(event.headers["content-type"]).toBe("application/json");
    expect(event.isBase64Encoded).toBe(true);
    expect(JSON.parse(Buffer.from(event.body!, "base64").toString("utf8"))).toEqual({ hello: "world" });

    expect(context?.requestId).toBe(event.requestContext.requestId);
    expect(context?.deadlineMs).toBeGreaterThan(Date.now() + 60_000);
    expect(context?.deadlineMs).toBeLessThanOrEqual(Date.now() + 90_000);
  });

  it("derives sourceIp from the rightmost X-Forwarded-For entry (proxy-appended, unspoofable)", async () => {
    harnessResponse = async () => ({ statusCode: 204 });
    await fetch(`${baseUrl}/`, {
      method: "POST",
      // Client prepends spoofed entries; traefik appends the real peer last.
      headers: { "x-forwarded-for": "1.1.1.1, 2.2.2.2, 203.0.113.7" },
      body: "{}",
    });
    expect(lastInvocation().event.requestContext.http.sourceIp).toBe("203.0.113.7");
  });

  it("splits the Cookie header into the Function URL cookies array", async () => {
    harnessResponse = async () => ({ statusCode: 204 });
    await fetch(`${baseUrl}/`, {
      method: "POST",
      headers: { Cookie: "session=abc; theme=dark" },
      body: "{}",
    });
    const { event } = lastInvocation();
    expect(event.cookies).toEqual(["session=abc", "theme=dark"]);
  });

  it("keeps binary bodies byte-exact through base64", async () => {
    harnessResponse = async () => ({ statusCode: 204 });
    const payload = new Uint8Array([0, 255, 1, 128, 10, 13, 0]);
    await fetch(`${baseUrl}/`, { method: "POST", body: payload });

    const { event } = lastInvocation();
    expect(event.isBase64Encoded).toBe(true);
    expect([...Buffer.from(event.body!, "base64")]).toEqual([...payload]);
  });

  it("omits the body for bodyless requests", async () => {
    harnessResponse = async () => ({ statusCode: 204 });
    await fetch(`${baseUrl}/status`);
    const { event } = lastInvocation();
    expect(event.body).toBeUndefined();
    expect(event.isBase64Encoded).toBe(false);
  });

  it("routes account-manage hosts to the account handler", async () => {
    const res = await fetch(`${baseUrl}/accounts/me`, {
      headers: { Host: "core-account.test.broods.app" },
    });
    expect(await res.json()).toEqual({ from: "account" });
    expect(accountCaptured.at(-1)?.event.requestContext.domainName).toBe("core-account.test.broods.app");
  });

  it("streams SSE chunks incrementally and maps headers and cookies", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    harnessResponse = async () => ({
      statusCode: 200,
      headers: { "Content-Type": "text/event-stream" },
      cookies: ["a=1", "b=2"],
      body: new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(new TextEncoder().encode("data: first\n\n"));
          await gate;
          controller.enqueue(new TextEncoder().encode("data: second\n\n"));
          controller.close();
        },
      }),
    });

    const res = await fetch(`${baseUrl}/`, { method: "POST", body: "{}" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.getSetCookie()).toEqual(["a=1", "b=2"]);

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const first = await reader.read();
    expect(decoder.decode(first.value)).toContain("data: first");
    // The second chunk must not have been delivered before the gate opens.
    release();
    let rest = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      rest += decoder.decode(value);
    }
    expect(rest).toContain("data: second");
  });

  it("does not drain until afterResponse work settles", async () => {
    let releaseAfter!: () => void;
    let afterDone = false;
    harnessResponse = async () => ({
      statusCode: 200,
      body: "ack",
      afterResponse: new Promise<void>((resolve) => {
        releaseAfter = resolve;
      }).then(() => {
        afterDone = true;
      }),
    });

    const res = await fetch(`${baseUrl}/`, { method: "POST", body: "{}" });
    expect(await res.text()).toBe("ack");

    const drained = core.drain().then(() => "drained" as const);
    const raced = await Promise.race([drained, Bun.sleep(50).then(() => "pending" as const)]);
    expect(raced).toBe("pending");
    expect(afterDone).toBe(false);

    releaseAfter();
    await drained;
    expect(afterDone).toBe(true);
  });

  it("returns 500 when a handler throws", async () => {
    harnessResponse = async () => {
      throw new Error("boom");
    };
    const res = await fetch(`${baseUrl}/`, { method: "POST", body: "{}" });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Internal server error" });
    harnessResponse = async () => ({ statusCode: 204 });
  });
});
