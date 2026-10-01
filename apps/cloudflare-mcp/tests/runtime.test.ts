/**
 * Runs the real Worker in local workerd (Miniflare) with a real Worker Loader,
 * so auth, bundle integrity, tenant isolation and egress are checked against
 * the runtime, not a mock. The outbound service stands in for S3 and the web.
 */

import { afterAll, beforeAll, beforeEach, expect, it } from "bun:test";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const BUNDLE_ORIGIN = "https://bundles.example.com";
const API_KEY = "local-key";
const TENANT_SOURCE = `export default async function (request) {
  const text = await request.text();
  if (text === "quotes") return new Response('"'.repeat(3_000_000));
  if (text === "slow") await fetch("https://slow.example.com/");
  if (text === "slow" || text === "fast") return new Response(text);
  const blocked = await fetch("${BUNDLE_ORIGIN}/other.mjs");
  const outside = await fetch("https://api.example.com/data");
  return Response.json({
    body: text,
    env: JSON.stringify(globalThis.process?.env ?? {}),
    blocked: blocked.status,
    outside: await outside.text(),
  });
}`;
const TENANT_SHA256 = new Bun.CryptoHasher("sha256")
  .update(TENANT_SOURCE)
  .digest("hex");

interface Frame {
  t: string;
  id?: string;
  error?: string;
  result?: { status: number; body: string };
}

let runtime: Miniflare;
let runtimeUrl: URL;
let bundleFetches = 0;

beforeAll(async (): Promise<void> => {
  const build = await Bun.build({
    entrypoints: [new URL("../src/index.ts", import.meta.url).pathname],
    format: "esm",
    target: "browser",
    external: ["cloudflare:workers"],
  });
  runtime = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: await build.outputs[0]!.text(),
      compatibilityDate: "2026-09-29",
      workerLoaders: { LOADER: {} },
      bindings: { MCP_API_KEY: API_KEY, BUNDLE_ORIGIN: BUNDLE_ORIGIN },
      outboundService: async (request: Request): Promise<Response> => {
        if (new URL(request.url).host === "slow.example.com") {
          await Bun.sleep(1_500);
        }
        if (new URL(request.url).origin !== BUNDLE_ORIGIN) {
          return new Response("public-ok");
        }
        bundleFetches++;

        return new Response(TENANT_SOURCE);
      },
    }),
  );
  // Bun's fetch, not dispatchFetch: Bun ignores the undici dispatcher it relies on.
  runtimeUrl = new URL("/mcp", await runtime.ready);
});

afterAll(async (): Promise<void> => {
  await runtime.dispose();
});

beforeEach((): void => {
  bundleFetches = 0;
});

it("refuses a wrong bearer before it downloads tenant code", async (): Promise<void> => {
  const response = await send(batch("acct-a"), "wrong");

  expect(response.status).toBe(401);
  expect(bundleFetches).toBe(0);
});

it("refuses a bundle url outside BUNDLE_ORIGIN", async (): Promise<void> => {
  const response = await send({
    ...batch("acct-a"),
    bundleUrl: "https://attacker.example.com/bundle.mjs",
  });

  expect(response.status).toBe(400);
  expect(bundleFetches).toBe(0);
});

it("runs a verified bundle with no secrets in reach and no path to the bundle store", async (): Promise<void> => {
  const response = await send(batch("acct-a"));
  const frames = await framesOf(response);

  expect(frames.map((frame): string => frame.t)).toEqual(["final", "end"]);
  expect(JSON.parse(frames[0]!.result!.body)).toEqual({
    body: "{}",
    env: "{}",
    blocked: 403,
    outside: "public-ok",
  });
  await send(batch("acct-a"));
  expect(bundleFetches).toBe(1);
});

it("fails the request when the bundle does not match its sha256", async (): Promise<void> => {
  const frames = await framesOf(
    await send({ ...batch("acct-b"), expectedSha256: "0".repeat(64) }),
  );

  expect(frames[0]).toMatchObject({ t: "error", id: "1" });
  expect(frames[0]!.error).toContain("sha256");
});

it("streams each frame as its request settles", async (): Promise<void> => {
  const frames = await framesOf(
    await send(batch("acct-a", ["slow", "fast", "PATCH"])),
  );

  // The slow request went first but answers last; PATCH passes like on Lambda.
  expect(
    frames.map((frame): string => `${frame.t}:${frame.id}`).slice(2),
  ).toEqual(["final:1", "end:undefined"]);
  expect(frames.find((frame): boolean => frame.id === "3")?.result?.body).toBe(
    "fast",
  );
});

it("budgets encoded frames, escaping included, against the 16 MiB batch cap", async (): Promise<void> => {
  // Each body is 3 MB raw but 6 MB once JSON escapes every quote.
  const response = await send(batch("acct-a", ["quotes", "quotes", "quotes"]));
  const text = await response.text();
  const frames = text
    .trim()
    .split("\n")
    .map((line): Frame => JSON.parse(line) as Frame);

  expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(
    16 * 1024 * 1024,
  );
  expect(frames.filter((frame): boolean => frame.t === "final")).toHaveLength(
    2,
  );
  expect(frames.find((frame): boolean => frame.t === "error")?.error).toContain(
    "16 MiB",
  );
  expect(frames.at(-1)?.t).toBe("end");
});

/** A batch whose request bodies pick the tenant's behaviour; `PATCH` sends `{}` as a PATCH. */
function batch(
  accountId: string,
  bodies: string[] = ["{}"],
): Record<string, unknown> {
  return {
    mode: "mcp",
    toolName: "tools",
    accountId: accountId,
    expectedSha256: TENANT_SHA256,
    bundleUrl: `${BUNDLE_ORIGIN}/account-mcp/${accountId}/bundles/${TENANT_SHA256}.mjs`,
    requests: bodies.map((body, index): Record<string, unknown> => ({
      id: String(index + 1),
      mcpRequest: {
        method: body === "PATCH" ? "PATCH" : "POST",
        headers: {},
        body: body === "PATCH" ? "fast" : body,
      },
    })),
  };
}

async function framesOf(response: Response): Promise<Frame[]> {
  return (await response.text())
    .trim()
    .split("\n")
    .map((line): Frame => JSON.parse(line) as Frame);
}

async function send(
  body: Record<string, unknown>,
  key = API_KEY,
): Promise<Response> {
  return await fetch(runtimeUrl, {
    method: "POST",
    headers: { authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
}
