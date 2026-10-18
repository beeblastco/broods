/**
 * Runs the real Worker in local workerd (Miniflare) with a real Worker Loader
 * and R2, so auth, the isolate boundary, persistence and the network policy
 * are checked against the runtime, not a mock. The outbound service stands in
 * for the web.
 */

import { afterAll, beforeAll, expect, it } from "bun:test";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { buildRuntime } from "../scripts/build-runtime.ts";
import type { ExecResult, IsolateExecRequest } from "../src/contract.ts";

const API_KEY = "local-key";

let runtime: Miniflare;
let runtimeUrl: URL;
let outboundHits = 0;

beforeAll(async (): Promise<void> => {
  await buildRuntime();
  const build = await Bun.build({
    entrypoints: [new URL("../src/index.ts", import.meta.url).pathname],
    format: "esm",
    target: "browser",
    external: ["cloudflare:workers"],
  });
  if (!build.success) throw new Error(build.logs.map(String).join("\n"));
  runtime = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: await build.outputs[0]!.text(),
      compatibilityDate: "2026-09-30",
      workerLoaders: { LOADER: {} },
      r2Buckets: ["STATE"],
      bindings: { ISOLATE_API_KEY: API_KEY },
      outboundService: async (): Promise<Response> => {
        outboundHits++;

        return new Response("public-ok");
      },
    }),
  );
  // Bun's fetch, not dispatchFetch: Bun ignores the undici dispatcher it relies on.
  runtimeUrl = new URL(await runtime.ready);
});

afterAll(async (): Promise<void> => {
  await runtime.dispose();
});

it("refuses a wrong bearer", async (): Promise<void> => {
  const response = await send("sb-auth", { script: "echo hi" }, "wrong");

  expect(response.status).toBe(401);
});

it("runs a script with its positionals in the requested directory", async (): Promise<void> => {
  const result = await exec("sb-run", {
    script: 'echo "$1+$2" "$PWD" "$GREETING"; echo oops >&2; exit 3',
    args: ["a b", "c'd"],
    cwd: "/workspace/app",
    env: { GREETING: "hello" },
  });

  expect(result).toMatchObject({
    ok: false,
    exit_code: 3,
    timed_out: false,
    stdout: "a b+c'd /workspace/app hello\n",
    stderr: "oops\n",
    truncated: false,
  });
  expect(result.duration_ms).toBeGreaterThanOrEqual(0);
});

it("keeps a reserved sandbox's files between calls and drops them on delete", async (): Promise<void> => {
  expect(await exists("sb-keep")).toBe(false);
  await exec("sb-keep", {
    script: "mkdir -p src && echo 'const a = 1' > src/a.ts",
    persist: true,
  });
  expect(await exists("sb-keep")).toBe(true);

  const read = await exec("sb-keep", { script: "cat src/a.ts", persist: true });

  expect(read.stdout).toBe("const a = 1\n");
  expect((await send("sb-keep", undefined, API_KEY, "DELETE")).status).toBe(
    204,
  );
  expect(await exists("sb-keep")).toBe(false);
  const gone = await exec("sb-keep", { script: "cat src/a.ts", persist: true });
  expect(gone.exit_code).not.toBe(0);
});

it("gives an ephemeral call an empty disk every time", async (): Promise<void> => {
  await exec("sb-once", { script: "echo x > x.txt" });

  expect((await exec("sb-once", { script: "ls" })).stdout).toBe("");
  expect(await exists("sb-once")).toBe(false);
});

it("has no network unless the sandbox allows internet", async (): Promise<void> => {
  const offline = await exec("sb-net", {
    script: "curl -s https://api.example.com/",
  });

  expect(offline.exit_code).toBe(127);
  expect(outboundHits).toBe(0);

  const online = await exec("sb-net", {
    script: "curl -s https://api.example.com/",
    enableInternet: true,
  });

  expect(online).toMatchObject({ ok: true, stdout: "public-ok" });
  expect(outboundHits).toBe(1);
});

it("stops a command at its timeout", async (): Promise<void> => {
  const result = await exec("sb-slow", { script: "sleep 10", timeoutMs: 500 });

  expect(result).toMatchObject({ ok: false, exit_code: null, timed_out: true });
});

it("caps each stream at the output limit", async (): Promise<void> => {
  const result = await exec("sb-big", {
    script: "yes | head -c 5000",
    outputLimitBytes: 1024,
  });

  expect(result.truncated).toBe(true);
  expect(result.stdout).toHaveLength(1024);
});

async function exec(
  id: string,
  request: Partial<IsolateExecRequest>,
): Promise<ExecResult> {
  const response = await send(id, request);
  if (response.status !== 200)
    throw new Error(`exec ${response.status}: ${await response.text()}`);

  return (await response.json()) as ExecResult;
}

async function exists(id: string): Promise<boolean> {
  const response = await send(id, undefined, API_KEY, "GET");
  const { exists } = (await response.json()) as { exists: boolean };

  return exists;
}

function send(
  id: string,
  request: Partial<IsolateExecRequest> | undefined,
  key: string = API_KEY,
  method: "DELETE" | "GET" | "POST" = "POST",
): Promise<Response> {
  const body: IsolateExecRequest | undefined =
    request === undefined
      ? undefined
      : {
          script: "true",
          args: [],
          cwd: "/workspace",
          env: {},
          timeoutMs: 10_000,
          outputLimitBytes: 64 * 1024,
          enableInternet: false,
          persist: false,
          ...request,
        };

  return fetch(
    new URL(
      `/v1/sandboxes/${id}${method === "POST" ? "/exec" : ""}`,
      runtimeUrl,
    ),
    {
      method: method,
      headers: { Authorization: `Bearer ${key}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  );
}
