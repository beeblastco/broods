/**
 * server.ts keeps its logic in exported functions rather than inside the
 * `import.meta.main` block: CoreRequest synthesis, path routing, waitUntil
 * draining, and the router that dispatches between the handlers. These tests
 * cover them without starting a server.
 */

import { describe, expect, it } from "bun:test";
import type { CoreRequest, RequestContext } from "../src/shared/http.ts";
import {
  createRoute,
  drainInFlight,
  routesToAccountManage,
  toCoreRequest,
  waitUntil,
  type CoreRouteHandlers,
} from "../src/server.ts";

async function buildCoreRequest(
  input: {
    url?: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
  socketAddress?: string,
): Promise<CoreRequest> {
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
      url: "http://127.0.0.1/v1/webhooks/acct/telegram?limit=2&q=a%20b",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Custom-Header": "Value-Kept",
        "x-forwarded-for": "203.0.113.9, 10.0.0.1",
      },
      body: JSON.stringify({ hello: "world" }),
    });

    expect(request.path).toBe("/v1/webhooks/acct/telegram");
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
    const withBody = await buildCoreRequest({
      method: "POST",
      body: "hello\nworld",
    });
    expect(withBody.body).toBe("hello\nworld");

    const bodyless = await buildCoreRequest({ url: "http://127.0.0.1/status" });
    expect(bodyless.body).toBe("");
  });
});

describe("routesToAccountManage", () => {
  it("routes signup, account delete, and sandbox lifecycle to account-manage", () => {
    expect(routesToAccountManage("POST", "/v1/accounts")).toBe(true);
    expect(routesToAccountManage("DELETE", "/v1/accounts/acct_1")).toBe(true);
    expect(routesToAccountManage("DELETE", "/v1/account")).toBe(true);
    expect(routesToAccountManage("POST", "/v1/sandboxes/sbx/exec")).toBe(true);
    expect(routesToAccountManage("POST", "/v1/sandboxes/sbx/terminate")).toBe(
      true,
    );
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
      "/v1/internal/observability-log",
      // Scoped invocation falls through even when the project slug shadows a resource name.
      "/v1/projects/skills/stages/prod/agents/endpoint-1",
      "/v1/internal/observability-scope",
      "/",
      "/status",
    ];
    for (const path of configPlanePaths) {
      expect(routesToAccountManage("POST", path)).toBe(false);
    }
    expect(routesToAccountManage("GET", "/v1/accounts")).toBe(false);
    expect(routesToAccountManage("GET", "/v1/accounts/acct_1")).toBe(false);
    expect(routesToAccountManage("PATCH", "/v1/accounts/acct_1")).toBe(false);
    expect(
      routesToAccountManage("POST", "/v1/accounts/acct_1/rotate-secret"),
    ).toBe(false);
    expect(routesToAccountManage("GET", "/v1/account")).toBe(false);
    expect(routesToAccountManage("PATCH", "/v1/account")).toBe(false);
    expect(routesToAccountManage("POST", "/v1/account/rotate-secret")).toBe(
      false,
    );
  });
});

describe("waitUntil drain", () => {
  it("does not drain until tracked work settles, and swallows failures", async () => {
    let release!: () => void;
    let afterDone = false;
    waitUntil(
      new Promise<void>((resolve) => {
        release = resolve;
      }).then(() => {
        afterDone = true;
      }),
    );
    waitUntil(Promise.reject(new Error("boom")));

    const drained = drainInFlight().then(() => "drained" as const);
    const raced = await Promise.race([
      drained,
      Bun.sleep(50).then(() => "pending" as const),
    ]);
    expect(raced).toBe("pending");
    expect(afterDone).toBe(false);

    release();
    await drained;
    expect(afterDone).toBe(true);
  });
});

describe("createRoute", () => {
  const REQUEST_BUDGET_MS = 60_000;

  function routeWith(overrides: Partial<CoreRouteHandlers> = {}): {
    route: ReturnType<typeof createRoute>;
    calls: string[];
    contexts: RequestContext[];
  } {
    const calls: string[] = [];
    const contexts: RequestContext[] = [];
    const route = createRoute(
      {
        accountHandler: async () => {
          calls.push("account");

          return new Response("account");
        },
        handleMediaRequest: async () => {
          calls.push("media");

          return new Response("media");
        },
        harnessHandler: async (_request, ctx) => {
          calls.push("harness");
          contexts.push(ctx);

          return new Response("harness");
        },
        routesToMedia: () => false,
        ...overrides,
      },
      REQUEST_BUDGET_MS,
    );

    return { route: route, calls: calls, contexts: contexts };
  }

  it("answers the health check before any handler runs", async () => {
    const { route, calls } = routeWith();

    const response = await route(new Request("http://core/healthz"), undefined);

    expect(await response.json()).toEqual({ status: "ok" });
    expect(calls).toEqual([]);
  });

  it("sends a media path to the media handler", async () => {
    const { route, calls } = routeWith({ routesToMedia: () => true });

    await route(new Request("http://core/v1/media/file"), undefined);

    expect(calls).toEqual(["media"]);
  });

  it("sends an account-manage verb to the account handler", async () => {
    const { route, calls } = routeWith();

    await route(
      new Request("http://core/v1/accounts", { method: "POST" }),
      undefined,
    );

    expect(calls).toEqual(["account"]);
  });

  it("sends everything else to the harness", async () => {
    const { route, calls } = routeWith();

    await route(
      new Request("http://core/v1/runs", { method: "POST" }),
      undefined,
    );

    expect(calls).toEqual(["harness"]);
  });

  it("gives the harness the request id and a deadline from the budget", async () => {
    const { route, contexts } = routeWith();
    const before = Date.now();

    await route(
      new Request("http://core/v1/runs", {
        method: "POST",
        headers: { "x-request-id": "req-1" },
      }),
      undefined,
    );

    expect(contexts[0]!.requestId).toBe("req-1");
    expect(contexts[0]!.deadlineMs).toBeGreaterThanOrEqual(
      before + REQUEST_BUDGET_MS,
    );
  });

  it("replaces an inbound request id that is not one we would issue", async () => {
    const { route } = routeWith();

    const response = await route(
      new Request("http://core/v1/runs", {
        method: "POST",
        headers: { "x-request-id": "not a valid id" },
      }),
      undefined,
    );

    expect(response.headers.get("x-request-id")).toBeTruthy();
    expect(response.headers.get("x-request-id")).not.toBe("not a valid id");
  });

  it("turns a handler failure into a stamped 500 envelope", async () => {
    const { route } = routeWith({
      harnessHandler: async () => {
        throw new Error("boom");
      },
    });

    const response = await route(
      new Request("http://core/v1/runs", {
        method: "POST",
        headers: { "x-request-id": "req-boom" },
      }),
      undefined,
    );

    expect(response.status).toBe(500);
    expect(response.headers.get("x-request-id")).toBe("req-boom");
    expect(await response.json()).toMatchObject({
      error: { message: "Internal server error", type: "api_error" },
    });
  });
});
