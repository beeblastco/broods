import { afterEach, expect, mock, test } from "bun:test";

class FakeEntrypoint<E, P> {
  env: E;
  ctx: { props: P };

  constructor(ctx: { props: P }, env: E) {
    this.ctx = ctx;
    this.env = env;
  }
}

// Workers ship this; Bun does not.
Object.defineProperty(crypto.subtle, "timingSafeEqual", {
  value: (a: ArrayBuffer, b: ArrayBuffer): boolean =>
    Buffer.from(a).equals(Buffer.from(b)),
});

await mock.module("cloudflare:workers", () => ({
  WorkerEntrypoint: FakeEntrypoint,
}));

// Lazy so the cloudflare:workers mock above is in place first.
const runtime = await import("../../../../apps/cloudflare-mcp/src/index.ts");
const worker = runtime.default as unknown as {
  fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response>;
};
const Outbound = runtime.TenantOutbound as unknown as new (
  ctx: { props: { blockedHosts: string[] } },
  env: unknown,
) => { fetch: (request: Request) => Promise<Response> };

interface TenantStub {
  ping: () => Promise<void>;
  fetch: (request: Request) => Promise<Response>;
}

interface Scenario {
  name: string;
  source?: string;
  r2Copy?: boolean;
  downloadStatus?: number;
  tenant?: Partial<TenantStub>;
  requests?: {
    id: string;
    mcpRequest: { method: string; headers: object; body?: string };
  }[];
  sha?: string;
  expected: string[];
  status?: number;
}

const API_KEY = "local-key";
const ORIGIN = "https://bundles.example.com";
const savedFetch = globalThis.fetch;
const DEFAULT_SOURCE = "export default () => new Response('ok');";

function sha256(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

function plainRequest(
  id: string,
  body = "hello",
): NonNullable<Scenario["requests"]>[number] {
  return {
    id: id,
    mcpRequest: { method: "POST", headers: { "x-a": "1" }, body: body },
  };
}

function post(body: string, key: string = API_KEY, path = "/mcp"): Request {
  return new Request(`https://mcp.example.workers.dev${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}` },
    body: body,
  });
}

async function runScenario(
  scenario: Scenario,
): Promise<{ status: number; text: string }> {
  const source = scenario.source ?? DEFAULT_SOURCE;
  const pending: Promise<unknown>[] = [];
  const tenant: TenantStub = {
    ping: async (): Promise<void> => {},
    fetch: async (request: Request): Promise<Response> =>
      new Response(`echo:${await request.text()}`, {
        status: 201,
        headers: { "x-t": "1" },
      }),
    ...scenario.tenant,
  };
  const env = {
    MCP_API_KEY: API_KEY,
    BUNDLE_ORIGIN: ORIGIN,
    BUNDLES: {
      get: async (): Promise<{
        arrayBuffer: () => Promise<ArrayBuffer>;
      } | null> =>
        scenario.r2Copy
          ? {
              arrayBuffer: async (): Promise<ArrayBuffer> =>
                new TextEncoder().encode(source).buffer as ArrayBuffer,
            }
          : null,
      put: async (): Promise<void> => {},
    },
    LOADER: {
      get: (
        _name: string,
        code: () => Promise<unknown>,
      ): {
        getEntrypoint: () => {
          ping: () => Promise<void>;
          fetch: TenantStub["fetch"];
        };
      } => {
        const loaded = code();
        loaded.catch((): void => {});

        return {
          getEntrypoint: (): {
            ping: () => Promise<void>;
            fetch: TenantStub["fetch"];
          } => ({
            ping: async (): Promise<void> => {
              await loaded;
              await tenant.ping();
            },
            fetch: tenant.fetch,
          }),
        };
      },
    },
  };
  const ctx = {
    waitUntil: (work: Promise<unknown>): void => {
      pending.push(work);
    },
    exports: { TenantOutbound: (): object => ({}) },
  };
  globalThis.fetch = mock(
    async (): Promise<Response> =>
      new Response(source, { status: scenario.downloadStatus ?? 200 }),
  ) as unknown as typeof fetch;
  const body = JSON.stringify({
    tenantId: "acct_1",
    expectedSha256: scenario.sha ?? sha256(source),
    bundleUrl: `${ORIGIN}/x.mjs`,
    requests: scenario.requests ?? [plainRequest("1")],
  });
  const response = await worker.fetch(post(body), env, ctx);
  const text = await response.text();
  await Promise.all(pending);

  return { status: response.status, text: text };
}

const SCENARIOS: Scenario[] = [
  {
    name: "body alpha",
    requests: [plainRequest("3", "alpha")],
    expected: ["echo:alpha", '{"t":"end"}'],
  },
  {
    name: "body beta",
    requests: [plainRequest("4", "beta")],
    expected: ["echo:beta", '{"t":"end"}'],
  },
  {
    name: "body gamma",
    requests: [plainRequest("5", "gamma")],
    expected: ["echo:gamma", '{"t":"end"}'],
  },
  {
    name: "body delta",
    requests: [plainRequest("6", "delta")],
    expected: ["echo:delta", '{"t":"end"}'],
  },
  {
    name: "body epsilon",
    requests: [plainRequest("7", "epsilon")],
    expected: ["echo:epsilon", '{"t":"end"}'],
  },
  {
    name: "downloaded bundle",
    expected: ['"t":"final"', "echo:hello", '{"t":"end"}'],
  },
  {
    name: "stored bundle",
    r2Copy: true,
    expected: ['"t":"final"', '"x-t":"1"'],
  },
  {
    name: "two requests",
    requests: [plainRequest("1", "a"), plainRequest("2", "b")],
    expected: ["echo:a", "echo:b"],
  },
  {
    name: "wrong hash",
    sha: "c".repeat(64),
    status: 422,
    expected: ["bundle failed to load: bundle sha256 does not match"],
  },
  {
    name: "download refused",
    downloadStatus: 404,
    status: 422,
    expected: ["bundle fetch failed with HTTP 404"],
  },
  {
    name: "tenant throws",
    tenant: {
      fetch: async (): Promise<Response> => {
        throw new Error("tenant broke");
      },
    },
    expected: ['"t":"error"', "tenant broke", '{"t":"end"}'],
  },
  {
    name: "tenant returns invalid utf8",
    tenant: {
      fetch: async (): Promise<Response> =>
        new Response(new Uint8Array([0xff, 0xfe])),
    },
    expected: ['"t":"error"', '{"t":"end"}'],
  },
  {
    name: "empty body",
    tenant: {
      fetch: async (): Promise<Response> => new Response(null, { status: 204 }),
    },
    expected: ['"status":204', '"body":""'],
  },
  {
    name: "ping throws",
    tenant: {
      ping: async (): Promise<void> => {
        throw new Error("no default export");
      },
    },
    status: 422,
    expected: ["bundle failed to load: no default export"],
  },
];

afterEach((): void => {
  globalThis.fetch = savedFetch;
});

test.each(SCENARIOS)(
  "worker: $name",
  async (scenario: Scenario): Promise<void> => {
    const result = await runScenario(scenario);

    expect(result.status).toBe(scenario.status ?? 200);
    for (const piece of scenario.expected) expect(result.text).toContain(piece);
  },
);

test.each([
  ["unconfigured", post("{}"), { MCP_API_KEY: "", BUNDLE_ORIGIN: ORIGIN }, 503],
  [
    "wrong key",
    post("{}", "nope"),
    { MCP_API_KEY: API_KEY, BUNDLE_ORIGIN: ORIGIN },
    401,
  ],
  [
    "wrong path",
    post("{}", API_KEY, "/x"),
    { MCP_API_KEY: API_KEY, BUNDLE_ORIGIN: ORIGIN },
    404,
  ],
  [
    "bad json",
    post("nope"),
    { MCP_API_KEY: API_KEY, BUNDLE_ORIGIN: ORIGIN },
    400,
  ],
  [
    "no fields",
    post("{}"),
    { MCP_API_KEY: API_KEY, BUNDLE_ORIGIN: ORIGIN },
    400,
  ],
  [
    "foreign origin",
    post(
      JSON.stringify({
        tenantId: "a",
        expectedSha256: "a".repeat(64),
        bundleUrl: "https://evil.example.com/x.mjs",
        requests: [plainRequest("1")],
      }),
    ),
    { MCP_API_KEY: API_KEY, BUNDLE_ORIGIN: ORIGIN },
    400,
  ],
] as const)(
  "worker guard: %s",
  async (_name, request, env, status): Promise<void> => {
    const response = await worker.fetch(request, env, {});

    expect(response.status).toBe(status);
  },
);

test.each([
  ["http://blocked.example.com/", 403],
  ["ftp://other.example.com/", 403],
  ["https://open.example.com/", 200],
])("outbound %s", async (url: string, status: number): Promise<void> => {
  globalThis.fetch = mock(
    async (): Promise<Response> => new Response("out"),
  ) as unknown as typeof fetch;
  const outbound = new Outbound(
    { props: { blockedHosts: ["blocked.example.com"] } },
    {},
  );

  const response = await outbound.fetch({ url: url } as Request);

  expect(response.status).toBe(status);
});
