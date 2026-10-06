/**
 * The gateway's request wiring: which check runs first, and what status each
 * one answers with. The helpers these reach are covered in `gateway.test.ts`;
 * what is covered here is the order they run in, which is a security contract.
 */

import { afterEach, expect, test } from "bun:test";
import {
  sealTerminalTicket,
  TERMINAL_WEBSOCKET_PATH,
  type TerminalTicket,
} from "../../core/src/shared/terminal-ticket.ts";
import {
  createGateway,
  gatewayConfigFromEnv,
  type GatewayConfig,
  type GatewayData,
} from "../src/main.ts";
import { RateLimiter } from "../src/rate-limiter.ts";
import type { SpentTickets } from "../src/terminal.ts";
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

test("a disallowed origin is refused before the auth-failure budget is read", async () => {
  const authFailureLimiter = new RateLimiter(1, 60_000);
  authFailureLimiter.allow("10.0.0.1");
  const gateway = createGateway(
    gatewayConfig({ authFailureLimiter: authFailureLimiter }),
  );

  const refused = await gateway.fetch(
    upgradeRequest("/v1/agents/endpoint-1/ws", { origin: "https://evil.test" }),
    fakeServer().server,
  );

  expect(refused!.status).toBe(403);
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
  expect(response!.headers.get("retry-after")).toBeTruthy();
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

test("an agent socket without a token is refused, even with ?token=", async () => {
  const gateway = createGateway(gatewayConfig());

  const response = await gateway.fetch(
    upgradeRequest("/v1/agents/endpoint-1/ws?token=runtime-key"),
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

test("a core outage during the token check is a 502 that spends no auth-failure budget", async (): Promise<void> => {
  globalThis.fetch = (async (): Promise<Response> =>
    new Response("down", { status: 503 })) as unknown as typeof fetch;
  const authFailureLimiter = new RateLimiter(1, 60_000);
  const gateway = createGateway(
    gatewayConfig({ authFailureLimiter: authFailureLimiter }),
  );

  const response = await gateway.fetch(
    upgradeRequest("/v1/agents/endpoint-1/ws", { token: "good" }),
    fakeServer().server,
  );

  expect(response!.status).toBe(502);
  expect(authFailureLimiter.blocked("10.0.0.1")).toBe(false);
});

test("a malformed escape in a socket path is a 400, not a 500", async (): Promise<void> => {
  const gateway = createGateway(gatewayConfig());

  const response = await gateway.fetch(
    upgradeRequest("/v1/agents/%E0%A4%A/ws", { token: "good" }),
    fakeServer().server,
  );

  expect(response!.status).toBe(400);
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

test("anything but a health check or a socket upgrade is a 404", async (): Promise<void> => {
  const gateway = createGateway(gatewayConfig());
  const { server } = fakeServer();

  const plain = await gateway.fetch(
    new Request("https://gw.example/v1/agents"),
    server,
  );
  const upgrade = await gateway.fetch(upgradeRequest("/v1/agents"), server);

  expect(plain!.status).toBe(404);
  expect(upgrade!.status).toBe(404);
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

  const request = upgradeRequest("/v1/agents/endpoint-1/ws");
  request.headers.set("x-request-id", "req-boom");
  const response = await gateway.fetch(request, server);

  expect(response!.status).toBe(500);
  expect(response!.headers.get("x-request-id")).toBe("req-boom");
});

test("the env config resolves the core and limiter the router reads", () => {
  const keys = [
    "BROODS_CORE_URL",
    "GATEWAY_AUTH_FAILURES_PER_MINUTE",
    "TERMINAL_TICKET_SECRET",
  ] as const;
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.BROODS_CORE_URL = "core.internal/";
    process.env.GATEWAY_AUTH_FAILURES_PER_MINUTE = "7";
    delete process.env.TERMINAL_TICKET_SECRET;

    expect(() => gatewayConfigFromEnv()).toThrow("TERMINAL_TICKET_SECRET");
    process.env.TERMINAL_TICKET_SECRET = "next-secret, old-secret,next-secret";

    const config = gatewayConfigFromEnv();

    expect(config.coreBaseUrl).toBe("https://core.internal");
    expect(config.authFailureLimiter.limit).toBe(7);
    expect(config.terminalTicketSecrets).toEqual(["next-secret", "old-secret"]);
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("a machine daemon upgrade needs a credential and is relayed to core's socket", async () => {
  const gateway = createGateway(gatewayConfig());
  const { server, upgrades } = fakeServer();

  const refused = await gateway.fetch(
    upgradeRequest("/v1/machines/ws"),
    server,
  );
  expect(refused?.status).toBe(401);

  const upgraded = await gateway.fetch(
    upgradeRequest("/v1/machines/ws", { token: "runtime-key" }),
    server,
  );
  expect(upgraded).toBeUndefined();
  expect(upgrades).toEqual([
    {
      kind: "machine",
      ticket: {
        url: "wss://core.example/v1/machines/ws",
        authorization: "Bearer runtime-key",
      },
    },
  ]);
});

test("a terminal ticket in the subprotocol opens one socket, and a replay spends auth budget", async () => {
  const authFailureLimiter = new RateLimiter(1, 60_000);
  const gateway = createGateway(
    gatewayConfig({ authFailureLimiter: authFailureLimiter }),
  );
  const { server, upgrades } = fakeServer();
  const ticket: TerminalTicket = {
    url: "wss://sandbox.example/pty",
    authorization: "Bearer org-key",
    accountId: "account-1",
    expiresAt: Date.now() + 60_000,
  };
  const token = sealTerminalTicket(ticket, "terminal-secret");
  const request = (): Request =>
    upgradeRequest(TERMINAL_WEBSOCKET_PATH, {
      subprotocols: ["broods.v1", `broods.token.${token}`],
    });

  expect(await gateway.fetch(request(), server)).toBeUndefined();
  expect(authFailureLimiter.blocked("10.0.0.1")).toBe(false);
  // The replay still upgrades so the open handler can close it with a reason.
  expect(await gateway.fetch(request(), server)).toBeUndefined();
  expect(authFailureLimiter.blocked("10.0.0.1")).toBe(true);
  expect(upgrades).toEqual([
    { kind: "terminal", ticket: ticket },
    { kind: "terminal", ticket: null },
  ]);
});

test("a terminal ticket spent on one gateway replica is refused on another", async () => {
  const spentTickets = memorySpentTickets();
  const first = createGateway(gatewayConfig({ spentTickets: spentTickets }));
  const second = createGateway(gatewayConfig({ spentTickets: spentTickets }));
  const { server, upgrades } = fakeServer();
  const ticket = terminalTicket();
  const token = sealTerminalTicket(ticket, "terminal-secret");
  const request = (): Request => terminalUpgradeRequest(token);

  expect(await first.fetch(request(), server)).toBeUndefined();
  expect(await second.fetch(request(), server)).toBeUndefined();
  expect(upgrades).toEqual([
    { kind: "terminal", ticket: ticket },
    { kind: "terminal", ticket: null },
  ]);
});

test("a terminal upgrade answers 502 when spent tickets cannot be checked", async () => {
  const gateway = createGateway(
    gatewayConfig({
      spentTickets: {
        spend: async function (): Promise<boolean> {
          throw new Error("NATS unavailable");
        },
        release: async function (): Promise<void> {},
      },
    }),
  );
  const { server, upgrades } = fakeServer();

  const response = await gateway.fetch(
    terminalUpgradeRequest(
      sealTerminalTicket(terminalTicket(), "terminal-secret"),
    ),
    server,
  );

  expect(response?.status).toBe(502);
  expect(upgrades).toEqual([]);
});

/** Upgrades like Bun: a plain empty `headers` object throws. */
function fakeServer(): {
  server: Bun.Server<GatewayData>;
  upgrades: GatewayData[];
} {
  const upgrades: GatewayData[] = [];
  const server = {
    requestIP: () => ({ address: "10.0.0.1", family: "IPv4", port: 4321 }),
    upgrade: (
      _request: Request,
      options: { data: GatewayData; headers?: HeadersInit },
    ) => {
      const { headers } = options;
      if (
        headers !== undefined &&
        !(headers instanceof Headers) &&
        Object.keys(headers).length === 0
      ) {
        throw new TypeError(
          "upgrade options.headers must be a Headers or an object",
        );
      }
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
    coreBaseUrl: "https://core.example",
    limits: limits(),
    spentTickets: memorySpentTickets(),
    terminalTicketSecrets: ["terminal-secret"],
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

/** Spent tickets in memory, shared by every gateway given the same one. */
function memorySpentTickets(): SpentTickets {
  const spent = new Set<string>();

  return {
    spend: async function (token: string): Promise<boolean> {
      if (spent.has(token)) return false;
      spent.add(token);

      return true;
    },
    release: async function (token: string): Promise<void> {
      spent.delete(token);
    },
  };
}

/** Core answering the scope lookup with a key bound to SCOPE. */
function scopeFetch(): typeof fetch {
  return (async () => Response.json(SCOPE)) as unknown as typeof fetch;
}

function terminalTicket(): TerminalTicket {
  return {
    url: "wss://sandbox.example/pty",
    authorization: "Bearer workdir-key",
    accountId: "account-1",
    expiresAt: Date.now() + 60_000,
  };
}

function terminalUpgradeRequest(token: string): Request {
  return upgradeRequest(TERMINAL_WEBSOCKET_PATH, {
    subprotocols: ["broods.v1", `broods.token.${token}`],
  });
}

function upgradeRequest(
  pathname: string,
  options: { origin?: string; subprotocols?: string[]; token?: string } = {},
): Request {
  const url = new URL(pathname, "https://gw.example");
  const headers = new Headers({ upgrade: "websocket" });
  headers.set("origin", options.origin ?? "https://broods.app");
  if (options.subprotocols)
    headers.set("sec-websocket-protocol", options.subprotocols.join(", "));
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);

  return new Request(url, { headers: headers });
}
