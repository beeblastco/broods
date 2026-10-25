/**
 * Runs the real Worker in local workerd (Miniflare) with a real Worker Loader
 * and R2, so auth, the isolate boundary, persistence and the network policy
 * are checked against the runtime, not a mock. The outbound service stands in
 * for the web.
 */

import { afterAll, beforeAll, expect, it } from "bun:test";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { buildRuntime } from "../scripts/build-runtime.ts";
import type { SandboxExecAnswer } from "../../core/src/shared/domain/sandbox-config.ts";
import type { WorkerExecRequest } from "../src/contract.ts";

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
      bindings: { WORKER_API_KEY: API_KEY },
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
});

it("keeps a reserved sandbox's files between calls and drops them on delete", async (): Promise<void> => {
  expect(await exists("sb-keep")).toBe(false);
  // A command that only reads stores no disk, not even its working directory.
  await exec("sb-keep", { script: "ls", persist: true });
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

it("stores only the first of two calls that raced on one disk and answers the other 409", async (): Promise<void> => {
  // The first call holds its disk open while the second reads the same one.
  const [first, second] = await Promise.all([
    send("sb-race", { script: "sleep 1; echo one > one.txt", persist: true }),
    send("sb-race", { script: "echo two > two.txt", persist: true }),
  ]);

  expect([first.status, second.status]).toEqual([409, 200]);
  const files = await exec("sb-race", { script: "ls", persist: true });
  expect(files.stdout).toBe("two.txt\n");
});

it("answers 409 to a write that raced with a call emptying the disk", async (): Promise<void> => {
  await exec("sb-wipe", { script: "echo a > a.txt", persist: true });
  const [wipe, write] = await Promise.all([
    send("sb-wipe", { script: "sleep 1; rm -rf /workspace", persist: true }),
    send("sb-wipe", { script: "echo b > b.txt", persist: true }),
  ]);

  expect([wipe.status, write.status]).toEqual([409, 200]);
  const files = await exec("sb-wipe", { script: "ls", persist: true });
  expect(files.stdout).toBe("a.txt\nb.txt\n");
});

it("keeps what a command wrote before it timed out", async (): Promise<void> => {
  const result = await exec("sb-late", {
    script: "echo kept > kept.txt; sleep 10",
    persist: true,
    timeoutMs: 500,
  });

  expect(result).toMatchObject({ ok: false, exit_code: null, timed_out: true });
  const files = await exec("sb-late", {
    script: "cat kept.txt",
    persist: true,
  });
  expect(files.stdout).toBe("kept\n");
});

it("answers a runtime failure with its message", async (): Promise<void> => {
  const bucket = await runtime.getR2Bucket("STATE");
  await bucket.put("sandboxes/sb-corrupt", new Uint8Array([1, 2, 3, 4, 5]));

  const response = await send("sb-corrupt", { script: "ls", persist: true });

  expect(response.status).toBe(500);
  expect(await response.text()).toContain("the sandbox's isolate failed");
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

it("caps each stream at the output limit on a character boundary", async (): Promise<void> => {
  const result = await exec("sb-big", {
    script: "yes | head -c 5000",
    outputLimitBytes: 1024,
  });
  // Three-byte characters: 1024 bytes cut one in half, so 341 whole ones stay.
  const wide = await exec("sb-wide", {
    script: "printf '€%.0s' $(seq 1 400)",
    outputLimitBytes: 1024,
  });

  // Past just-bash's old total cap: cut, not dropped.
  const huge = await exec("sb-huge", {
    script:
      "awk 'BEGIN{for(i=0;i<60000;i++) print \"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\"}'",
    outputLimitBytes: 64 * 1024,
  });

  expect(result.truncated).toBe(true);
  expect(result.stdout).toHaveLength(1024);
  expect(wide.truncated).toBe(true);
  expect(wide.stdout).toBe("€".repeat(341));
  expect(huge).toMatchObject({ ok: true, exit_code: 0, truncated: true });
  expect(huge.stdout).toHaveLength(64 * 1024);
});

async function exec(
  id: string,
  request: Partial<WorkerExecRequest>,
): Promise<SandboxExecAnswer> {
  const response = await send(id, request);
  if (response.status !== 200)
    throw new Error(`exec ${response.status}: ${await response.text()}`);

  return (await response.json()) as SandboxExecAnswer;
}

async function exists(id: string): Promise<boolean> {
  const response = await send(id, undefined, API_KEY, "GET");
  const { exists } = (await response.json()) as { exists: boolean };

  return exists;
}

function send(
  id: string,
  request: Partial<WorkerExecRequest> | undefined,
  key: string = API_KEY,
  method: "DELETE" | "GET" | "POST" = "POST",
): Promise<Response> {
  const body: WorkerExecRequest | undefined =
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
