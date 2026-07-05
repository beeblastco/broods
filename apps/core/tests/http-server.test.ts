/**
 * Container HTTP server tests.
 * Cover HTTP-to-CoreRequest synthesis, path routing, SSE streaming, and
 * waitUntil drain ordering for the self-hosted core server here.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { createCoreServer, type CoreServer } from "../src/server.ts";
import type { CoreRequest, RequestContext } from "../src/shared/http.ts";

interface CapturedInvocation {
  request: CoreRequest;
  context: RequestContext;
}

const captured: CapturedInvocation[] = [];
const accountCaptured: CapturedInvocation[] = [];
let harnessResponse: (ctx: RequestContext) => Promise<Response> = async () => new Response(null, { status: 204 });

const core: CoreServer = createCoreServer({
  harnessHandler: async (request, context) => {
    captured.push({ request, context });
    return harnessResponse(context);
  },
  accountHandler: async (request, context) => {
    accountCaptured.push({ request, context });
    return Response.json({ from: "account" });
  },
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

  it("builds the CoreRequest shape", async () => {
    harnessResponse = async () => new Response(null, { status: 204 });
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

    const { request, context } = lastInvocation();
    expect(request.path).toBe("/webhooks/acct/agent/telegram");
    expect(request.search).toBe("limit=2&q=a%20b");
    expect(request.query.get("limit")).toBe("2");
    expect(request.query.get("q")).toBe("a b");
    expect(request.method).toBe("POST");
    // Rightmost XFF entry (the proxy-appended peer), not the spoofable leftmost.
    expect(request.clientIp).toBe("10.0.0.1");
    expect(request.headers["x-custom-header"]).toBe("Value-Kept");
    expect(request.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(request.body)).toEqual({ hello: "world" });

    expect(context.requestId).toBeString();
    expect(context.deadlineMs).toBeGreaterThan(Date.now() + 60_000);
    expect(context.deadlineMs).toBeLessThanOrEqual(Date.now() + 90_000);
  });

  it("derives sourceIp from the rightmost X-Forwarded-For entry (proxy-appended, unspoofable)", async () => {
    harnessResponse = async () => new Response(null, { status: 204 });
    await fetch(`${baseUrl}/`, {
      method: "POST",
      // Client prepends spoofed entries; traefik appends the real peer last.
      headers: { "x-forwarded-for": "1.1.1.1, 2.2.2.2, 203.0.113.7" },
      body: "{}",
    });
    expect(lastInvocation().request.clientIp).toBe("203.0.113.7");
  });

  it("splits the Cookie header into the CoreRequest cookies array", async () => {
    harnessResponse = async () => new Response(null, { status: 204 });
    await fetch(`${baseUrl}/`, {
      method: "POST",
      headers: { Cookie: "session=abc; theme=dark" },
      body: "{}",
    });
    const { request } = lastInvocation();
    expect(request.cookies).toEqual(["session=abc", "theme=dark"]);
  });

  it("passes UTF-8 request bodies through as text", async () => {
    harnessResponse = async () => new Response(null, { status: 204 });
    await fetch(`${baseUrl}/`, { method: "POST", body: "hello\nworld" });

    const { request } = lastInvocation();
    expect(request.body).toBe("hello\nworld");
  });

  it("uses an empty body string for bodyless requests", async () => {
    harnessResponse = async () => new Response(null, { status: 204 });
    await fetch(`${baseUrl}/status`);
    const { request } = lastInvocation();
    expect(request.body).toBe("");
  });

  it("routes /accounts paths to the account handler regardless of Host", async () => {
    const res = await fetch(`${baseUrl}/v1/account`, {
      // The gateway strips Host on proxy, so routing must not depend on it.
      headers: { Host: "anything.example.com" },
    });
    expect(await res.json()).toEqual({ from: "account" });
    expect(accountCaptured.at(-1)?.request.path).toBe("/v1/account");
  });

  it("routes /v1 account resources to the account handler and invocations to the harness", async () => {
    harnessResponse = async () => new Response(null, { status: 204 });

    // Resource CRUD still owned by core plus sandbox lifecycle → account handler.
    for (const path of ["/v1/agents", "/v1/sandboxes/sbx/exec"]) {
      const before = accountCaptured.length;
      await fetch(`${baseUrl}${path}`);
      expect(accountCaptured.length).toBe(before + 1);
    }

    // Skills, tools, workspace files, cron, policy, workspace, and sandbox
    // config CRUD are Convex config-plane routes (gateway-forwarded); a core
    // hit falls through to the harness 404 path.
    for (const path of [
      "/v1/skills",
      "/v1/tools/tool-1",
      "/v1/workspaces/ws/files",
      "/v1/crons/abc/runs",
      "/v1/workspaces/ws",
      "/v1/policies/pol-1",
      "/v1/sandboxes/sbx",
    ]) {
      const before = captured.length;
      await fetch(`${baseUrl}${path}`);
      expect(captured.length).toBe(before + 1);
    }

    // Method split on /v1/agents/{id}: POST invokes (harness), GET reads config (account).
    const accountBefore = accountCaptured.length;
    await fetch(`${baseUrl}/v1/agents/my-agent`);
    expect(accountCaptured.length).toBe(accountBefore + 1);

    const harnessBefore = captured.length;
    await fetch(`${baseUrl}/v1/agents/my-agent`, { method: "POST", body: "{}" });
    await fetch(`${baseUrl}/v1/agents/my-agent/async`, { method: "POST", body: "{}" });
    // Scoped invocation falls through even when the project slug shadows a resource name.
    await fetch(`${baseUrl}/v1/skills/agents/prod/endpoint-1`, { method: "POST", body: "{}" });
    expect(captured.length).toBe(harnessBefore + 3);
  });

  it("splits the /v1/internal leaves: observability-log to account, observability-scope to harness", async () => {
    harnessResponse = async () => new Response(null, { status: 204 });

    const accountBefore = accountCaptured.length;
    await fetch(`${baseUrl}/v1/internal/observability-log`, { method: "POST", body: "{}" });
    expect(accountCaptured.length).toBe(accountBefore + 1);

    const harnessBefore = captured.length;
    await fetch(`${baseUrl}/v1/internal/observability-scope`, { method: "POST", body: "{}" });
    expect(captured.length).toBe(harnessBefore + 1);
  });

  it("streams SSE chunks incrementally and maps headers and cookies", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    harnessResponse = async () => new Response(
      new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(new TextEncoder().encode("data: first\n\n"));
          await gate;
          controller.enqueue(new TextEncoder().encode("data: second\n\n"));
          controller.close();
        },
      }),
      {
        status: 200,
        headers: [
          ["Content-Type", "text/event-stream"],
          ["Set-Cookie", "a=1"],
          ["Set-Cookie", "b=2"],
        ],
      },
    );

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

  it("does not drain until waitUntil work settles", async () => {
    let releaseAfter!: () => void;
    let afterDone = false;
    harnessResponse = async (ctx) => {
      ctx.waitUntil(new Promise<void>((resolve) => {
        releaseAfter = resolve;
      }).then(() => {
        afterDone = true;
      }));
      return new Response("ack");
    };

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
    harnessResponse = async () => new Response(null, { status: 204 });
  });
});
