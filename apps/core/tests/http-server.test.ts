/**
 * Core server helper tests.
 * server.ts is a flat Bun.serve script; its logic lives in exported pure
 * helpers — CoreRequest synthesis, path routing, and waitUntil draining —
 * which are covered here without starting a server.
 */

import { describe, expect, it } from "bun:test";
import { drainInFlight, routesToAccountManage, toCoreRequest, waitUntil } from "../src/server.ts";

async function buildCoreRequest(
  input: { url?: string; method?: string; headers?: Record<string, string>; body?: string },
  socketAddress?: string,
) {
  const url = new URL(input.url ?? "http://127.0.0.1/");
  const request = new Request(url.toString(), {
    method: input.method ?? "GET",
    headers: input.headers,
    ...(input.body !== undefined ? { body: input.body } : {}),
  });

  return toCoreRequest(request, url, socketAddress);
}

describe("toCoreRequest", () => {
  it("builds the CoreRequest shape", async () => {
    const request = await buildCoreRequest({
      url: "http://127.0.0.1/webhooks/acct/agent/telegram?limit=2&q=a%20b",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Custom-Header": "Value-Kept",
        "x-forwarded-for": "203.0.113.9, 10.0.0.1",
      },
      body: JSON.stringify({ hello: "world" }),
    });

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
  });

  it("derives clientIp from the rightmost X-Forwarded-For entry (proxy-appended, unspoofable)", async () => {
    // Client prepends spoofed entries; traefik appends the real peer last.
    const request = await buildCoreRequest({
      method: "POST",
      headers: { "x-forwarded-for": "1.1.1.1, 2.2.2.2, 203.0.113.7" },
      body: "{}",
    });
    expect(request.clientIp).toBe("203.0.113.7");
  });

  it("falls back to the socket address without X-Forwarded-For", async () => {
    const request = await buildCoreRequest({}, "192.0.2.4");
    expect(request.clientIp).toBe("192.0.2.4");
  });

  it("splits the Cookie header into the cookies array", async () => {
    const request = await buildCoreRequest({
      method: "POST",
      headers: { Cookie: "session=abc; theme=dark" },
      body: "{}",
    });
    expect(request.cookies).toEqual(["session=abc", "theme=dark"]);
  });

  it("passes UTF-8 request bodies through as text and uses empty string when bodyless", async () => {
    const withBody = await buildCoreRequest({ method: "POST", body: "hello\nworld" });
    expect(withBody.body).toBe("hello\nworld");

    const bodyless = await buildCoreRequest({ url: "http://127.0.0.1/status" });
    expect(bodyless.body).toBe("");
  });
});

describe("routesToAccountManage", () => {
  it("routes signup, account delete, sandbox lifecycle, and the observability leaf to account-manage", () => {
    expect(routesToAccountManage("POST", "/accounts")).toBe(true);
    expect(routesToAccountManage("DELETE", "/accounts/acct_1")).toBe(true);
    expect(routesToAccountManage("DELETE", "/v1/account")).toBe(true);
    expect(routesToAccountManage("POST", "/v1/sandboxes/sbx/exec")).toBe(true);
    expect(routesToAccountManage("POST", "/v1/sandboxes/sbx/terminate")).toBe(true);
    expect(routesToAccountManage("POST", "/v1/internal/observability-log")).toBe(true);
  });

  it("routes config-plane CRUD paths and invocations to the harness", () => {
    // Account metadata/rotation plus agent, skills, tools, workspace files,
    // cron, policy, workspace, and sandbox config CRUD are Convex config-plane
    // routes (gateway-forwarded); a core hit falls through to the harness 404
    // path. Invocations are harness-owned.
    const configPlanePaths = [
      "/v1/agents",
      "/v1/agents/my-agent",
      "/v1/agents/my-agent/async",
      "/v1/skills",
      "/v1/tools/tool-1",
      "/v1/workspaces/ws/files",
      "/v1/crons/abc/runs",
      "/v1/workspaces/ws",
      "/v1/policies/pol-1",
      "/v1/sandboxes/sbx",
      // Scoped invocation falls through even when the project slug shadows a resource name.
      "/v1/skills/agents/prod/endpoint-1",
      "/v1/internal/observability-scope",
      "/",
      "/status",
    ];
    for (const path of configPlanePaths) {
      expect(routesToAccountManage("POST", path)).toBe(false);
    }
    expect(routesToAccountManage("GET", "/accounts")).toBe(false);
    expect(routesToAccountManage("GET", "/accounts/acct_1")).toBe(false);
    expect(routesToAccountManage("PATCH", "/accounts/acct_1")).toBe(false);
    expect(routesToAccountManage("POST", "/accounts/acct_1/rotate-secret")).toBe(false);
    expect(routesToAccountManage("GET", "/v1/account")).toBe(false);
    expect(routesToAccountManage("PATCH", "/v1/account")).toBe(false);
    expect(routesToAccountManage("POST", "/v1/account/rotate-secret")).toBe(false);
  });
});

describe("waitUntil drain", () => {
  it("does not drain until tracked work settles, and swallows failures", async () => {
    let release!: () => void;
    let afterDone = false;
    waitUntil(new Promise<void>((resolve) => {
      release = resolve;
    }).then(() => {
      afterDone = true;
    }));
    waitUntil(Promise.reject(new Error("boom")));

    const drained = drainInFlight().then(() => "drained" as const);
    const raced = await Promise.race([drained, Bun.sleep(50).then(() => "pending" as const)]);
    expect(raced).toBe("pending");
    expect(afterDone).toBe(false);

    release();
    await drained;
    expect(afterDone).toBe(true);
  });
});
