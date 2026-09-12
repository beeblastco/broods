/**
 * The gateway's request wiring: which check runs first, and what status each
 * one answers with. The helpers these reach are covered in `gateway.test.ts`;
 * what is covered here is the order they run in, which is a security contract.
 */

import { afterEach, expect, test } from "bun:test";
import {
  createGateway,
  gatewayConfigFromEnv,
  type GatewayConfig,
  type GatewayData,
} from "../src/main.ts";
import { RateLimiter } from "../src/rate-limiter.ts";
import type { GatewayLimits } from "../src/utils.ts";

const SCOPE = {
  accountId: "account-1",
  projectSlug: "project",
  stageSlug: "production",
  endpointIds: ["endpoint-1"],
};

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("healthz reports the socket count against the ceiling", async () => {
  const gateway = createGateway(
    gatewayConfig({ limits: limits({ maxConnections: 7 }) }),
  );

  const response = await gateway.fetch(
    new Request("https://gw.example/healthz"),
    fakeServer().server,
  );

  expect(await response!.json()).toEqual({
    status: "ok",
    activeWebSockets: 0,
    maxWebSockets: 7,
  });
});

test("a disallowed origin is refused before the upgrade limiter counts it", async () => {
  const upgradeLimiter = new RateLimiter(1, 60_000);
  const gateway = createGateway(
    gatewayConfig({ upgradeLimiter: upgradeLimiter }),
  );
  const { server } = fakeServer();

  const refused = await gateway.fetch(
    upgradeRequest("/v1/agents/endpoint-1/ws", { origin: "https://evil.test" }),
    server,
  );

  expect(refused!.status).toBe(403);
  // The limiter allows one per window. If the refused request had consumed it,
  // this allowed-origin request would come back 429 instead of 401.
  const next = await gateway.fetch(
    upgradeRequest("/v1/agents/endpoint-1/ws"),
    server,
  );
  expect(next!.status).toBe(401);
});

test("too many upgrades answers 429 with the retry headers", async () => {
  const gateway = createGateway(
    gatewayConfig({ upgradeLimiter: new RateLimiter(1, 60_000) }),
  );
  const { server } = fakeServer();

  await gateway.fetch(upgradeRequest("/v1/agents/endpoint-1/ws"), server);
  const limited = await gateway.fetch(
    upgradeRequest("/v1/agents/endpoint-1/ws"),
    server,
  );

  expect(limited!.status).toBe(429);
  expect(limited!.headers.get("retry-after")).toBeTruthy();
});

test("a blocked auth-failure budget answers before the token check", async () => {
  const authFailureLimiter = new RateLimiter(1, 60_000);
  authFailureLimiter.allow("10.0.0.1");
  const gateway = createGateway(
    gatewayConfig({ authFailureLimiter: authFailureLimiter }),
  );

  // No token, so the per-path check would answer 401 if it ran first.
  const response = await gateway.fetch(
    upgradeRequest("/v1/agents/endpoint-1/ws"),
    fakeServer().server,
  );

  expect(response!.status).toBe(429);
  expect(await response!.json()).toMatchObject({
    error: { message: "Too many failed authentication attempts" },
  });
});

test("a full gateway answers 503 before the token check", async () => {
  const gateway = createGateway(
    gatewayConfig({ limits: limits({ maxConnections: 0 }) }),
  );

  const response = await gateway.fetch(
    upgradeRequest("/v1/agents/endpoint-1/ws"),
    fakeServer().server,
  );

  expect(response!.status).toBe(503);
});

test("an agent socket without a token is refused", async () => {
  const gateway = createGateway(gatewayConfig());

  const response = await gateway.fetch(
    upgradeRequest("/v1/agents/endpoint-1/ws"),
    fakeServer().server,
  );

  expect(response!.status).toBe(401);
  expect(await response!.json()).toMatchObject({
    error: { message: "Missing WebSocket token" },
  });
});

test("an unresolvable token is refused and spends auth-failure budget", async () => {
  globalThis.fetch = (async () =>
    new Response("no", { status: 401 })) as unknown as typeof fetch;
  const authFailureLimiter = new RateLimiter(1, 60_000);
  const gateway = createGateway(
    gatewayConfig({ authFailureLimiter: authFailureLimiter }),
  );

  const response = await gateway.fetch(
    upgradeRequest("/v1/agents/endpoint-1/ws", { token: "bad" }),
    fakeServer().server,
  );

  expect(response!.status).toBe(401);
  expect(authFailureLimiter.blocked("10.0.0.1")).toBe(true);
});

test("a token scoped to another endpoint cannot attach", async () => {
  globalThis.fetch = scopeFetch();
  const gateway = createGateway(gatewayConfig());

  const response = await gateway.fetch(
    upgradeRequest("/v1/agents/endpoint-2/ws", { token: "good" }),
    fakeServer().server,
  );

  expect(response!.status).toBe(403);
});

test("a token scoped to another stage cannot attach", async () => {
  globalThis.fetch = scopeFetch();
  const gateway = createGateway(gatewayConfig());

  const response = await gateway.fetch(
    upgradeRequest("/v1/projects/project/stages/staging/agents/endpoint-1/ws", {
      token: "good",
    }),
    fakeServer().server,
  );

  expect(response!.status).toBe(403);
});

test("a matching scope upgrades and binds the socket to its account", async () => {
  globalThis.fetch = scopeFetch();
  const gateway = createGateway(gatewayConfig());
  const { server, upgrades } = fakeServer();

  const response = await gateway.fetch(
    upgradeRequest("/v1/agents/endpoint-1/ws", { token: "good" }),
    server,
  );

  expect(response).toBeUndefined();
  expect(upgrades[0]).toMatchObject({
    kind: "agent-test",
    corePath: "/v1/agents/endpoint-1",
    accountId: "account-1",
  });
});

test("an observability socket bound to another project is refused", async () => {
  globalThis.fetch = scopeFetch();
  const gateway = createGateway(gatewayConfig());

  const response = await gateway.fetch(
    upgradeRequest("/v1/projects/other/stages/production/observability/ws", {
      token: "good",
    }),
    fakeServer().server,
  );

  expect(response!.status).toBe(403);
});

test("a config path with no config plane configured answers 503", async () => {
  const gateway = createGateway(gatewayConfig({ configBaseUrl: undefined }));

  const response = await gateway.fetch(
    new Request("https://gw.example/v1/agents"),
    fakeServer().server,
  );

  expect(response!.status).toBe(503);
});

test("a path on neither upstream is a 404", async () => {
  const gateway = createGateway(gatewayConfig());

  const response = await gateway.fetch(
    new Request("https://gw.example/not-a-route"),
    fakeServer().server,
  );

  expect(response!.status).toBe(404);
});

test("the opt-in HTTP ceiling meters the proxied branch", async () => {
  const gateway = createGateway(
    gatewayConfig({ httpLimiter: new RateLimiter(1, 60_000) }),
  );
  const { server } = fakeServer();

  await gateway.fetch(new Request("https://gw.example/not-a-route"), server);
  const limited = await gateway.fetch(
    new Request("https://gw.example/not-a-route"),
    server,
  );

  expect(limited!.status).toBe(429);
});

test("every response carries a request id, reusing a well-formed inbound one", async () => {
  const gateway = createGateway(gatewayConfig());
  const { server } = fakeServer();

  const generated = await gateway.fetch(
    new Request("https://gw.example/not-a-route"),
    server,
  );
  const reused = await gateway.fetch(
    new Request("https://gw.example/not-a-route", {
      headers: { "x-request-id": "req-abc" },
    }),
    server,
  );

  expect(generated!.headers.get("x-request-id")).toBeTruthy();
  expect(reused!.headers.get("x-request-id")).toBe("req-abc");
});

test("a router failure is a 500 that still carries its request id", async () => {
  const gateway = createGateway(gatewayConfig());
  const server = {
    requestIP: () => {
      throw new Error("no peer");
    },
    upgrade: () => false,
  } as unknown as Bun.Server<GatewayData>;

  const response = await gateway.fetch(
    new Request("https://gw.example/not-a-route", {
      headers: { "x-request-id": "req-boom" },
    }),
    server,
  );

  expect(response!.status).toBe(500);
  expect(response!.headers.get("x-request-id")).toBe("req-boom");
});

test("the env config resolves the upstreams and limiters the router reads", () => {
  const keys = [
    "BROODS_CORE_URLS",
    "BROODS_CONFIG_URL",
    "GATEWAY_UPGRADES_PER_MINUTE",
    "GATEWAY_HTTP_REQUESTS_PER_MINUTE",
  ] as const;
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.BROODS_CORE_URLS = "core.internal,https://core-2.internal/";
    process.env.BROODS_CONFIG_URL = "config.internal";
    process.env.GATEWAY_UPGRADES_PER_MINUTE = "7";
    delete process.env.GATEWAY_HTTP_REQUESTS_PER_MINUTE;

    const config = gatewayConfigFromEnv();

    expect(config.coreBaseUrls).toEqual([
      "https://core.internal",
      "https://core-2.internal",
    ]);
    expect(config.configBaseUrl).toBe("https://config.internal");
    expect(config.upgradeLimiter.limit).toBe(7);
    // Off unless set, because channel webhooks arrive on the proxied branch
    // from one provider's egress addresses.
    expect(config.httpLimiter).toBeUndefined();
    expect(config.proxyOptions.forwardAccountId).toBe(true);
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

function fakeServer(): {
  server: Bun.Server<GatewayData>;
  upgrades: GatewayData[];
} {
  const upgrades: GatewayData[] = [];
  const server = {
    requestIP: () => ({ address: "10.0.0.1", family: "IPv4", port: 4321 }),
    upgrade: (_request: Request, options: { data: GatewayData }) => {
      upgrades.push(options.data);

      return true;
    },
  } as unknown as Bun.Server<GatewayData>;

  return { server: server, upgrades: upgrades };
}

function gatewayConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    allowedOrigins: ["broods.app", "*.broods.app"],
    authFailureLimiter: new RateLimiter(20, 60_000),
    configBaseUrl: "https://config.example",
    coreBaseUrls: ["https://core.example"],
    httpLimiter: undefined,
    limits: limits(),
    proxyOptions: { forwardAccountId: true },
    upgradeLimiter: new RateLimiter(120, 60_000),
    ...overrides,
  };
}

function limits(overrides: Partial<GatewayLimits> = {}): GatewayLimits {
  return {
    maxConnections: 10,
    maxPayloadBytes: 1024,
    backpressureBytes: 1024,
    idleTimeoutSeconds: 60,
    runStartTimeoutMs: 1_000,
    ...overrides,
  };
}

/** Core answering the scope lookup with a key bound to SCOPE. */
function scopeFetch(): typeof fetch {
  return (async () => Response.json(SCOPE)) as unknown as typeof fetch;
}

function upgradeRequest(
  pathname: string,
  options: { origin?: string; token?: string } = {},
): Request {
  const url = new URL(pathname, "https://gw.example");
  const headers = new Headers({ upgrade: "websocket" });
  headers.set("origin", options.origin ?? "https://broods.app");
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);

  return new Request(url, { headers: headers });
}
