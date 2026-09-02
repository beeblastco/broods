/**
 * Hosted-MCP child runner (child-runner.mjs) tests.
 * Spawn the runner under real Node — no AWS, no native addons — and assert the
 * NDJSON frames for the mcp-mode contract: fetch-handler exports (plain
 * function and { fetch } object), the serialized request/response mapping,
 * the batch protocol (#397: tagged frames per request, `end` per batch), and
 * the payload/hash integrity guards.
 */

import { describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import type { Writable } from "node:stream";
import { fileURLToPath } from "node:url";

const childRunnerPath = fileURLToPath(
  new URL("../../lambda/child-runner.mjs", import.meta.url),
);

interface HostedResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

describe("mcp child-runner", () => {
  it("runs a fetch-handler export and returns the serialized response", async () => {
    const result = await runChild(
      `export default async (request) => {
         const body = await request.text();
         return new Response(JSON.stringify({ method: request.method, echoed: body }), {
           status: 200,
           headers: { "content-type": "application/json" },
         });
       };`,
      { body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }) },
    );

    expect(result.exitCode).toBe(0);
    const frame = finalFrame(result.frames);
    expect(frame.id).toBe("1");
    expect(frame.result.status).toBe(200);
    expect(JSON.parse(frame.result.body)).toEqual({
      method: "POST",
      echoed: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
    });
    expect(result.frames.at(-1)).toEqual({ t: "end" });
  });

  it("answers every request of a batch as it settles, tagged with its id", async () => {
    // Handlers that finish out of order: the frames arrive in completion
    // order, each carrying the id core needs to route it.
    const result = await runChild(
      `export default async (request) => {
         const { id, delay, fail } = JSON.parse(await request.text());
         await new Promise((resolve) => setTimeout(resolve, delay));
         if (fail) throw new Error("boom " + id);
         return new Response(JSON.stringify({ id: id }));
       };`,
      {
        requests: [
          { body: JSON.stringify({ id: 1, delay: 60 }) },
          { body: JSON.stringify({ id: 2, delay: 0 }) },
          { body: JSON.stringify({ id: 3, delay: 30, fail: true }) },
        ],
      },
    );

    expect(result.exitCode).toBe(0);
    expect(
      result.frames.map((frame) => {
        const tagged = frame as {
          t: string;
          id?: string;
          result?: HostedResponse;
        };

        return [tagged.t, tagged.id, tagged.result?.body];
      }),
    ).toEqual([
      ["final", "2", '{"id":2}'],
      ["error", "3", undefined],
      ["final", "1", '{"id":1}'],
      ["end", undefined, undefined],
    ]);
    expect(result.frames[1]).toEqual({ t: "error", id: "3", error: "boom 3" });
  });

  it("accepts a { fetch } object export like createMcpHandler returns", async () => {
    const result = await runChild(
      `export default { fetch: () => new Response("ok", { status: 201 }) };`,
      {},
    );

    const frame = finalFrame(result.frames);
    expect(frame.result.status).toBe(201);
    expect(frame.result.body).toBe("ok");
  });

  it("forwards the request headers into the handler", async () => {
    const result = await runChild(
      `export default (request) =>
         new Response(request.headers.get("authorization") ?? "missing");`,
      { headers: { authorization: "Bearer scoped-secret" } },
    );

    expect(finalFrame(result.frames).result.body).toBe("Bearer scoped-secret");
  });

  it("rejects a bundle hash mismatch", async () => {
    const result = await runChild(`export default () => new Response("x");`, {
      expectedSha256: "b".repeat(64),
    });

    expect(result.frames).toEqual([
      { t: "error", error: "bundle hash mismatch inside mcp runner" },
    ]);
    expect(result.exitCode).toBe(1);
  });

  it("rejects a payload without mcp mode", async () => {
    const result = await runChild(`export default () => new Response("x");`, {
      omitMode: true,
    });

    expect(result.frames).toEqual([
      { t: "error", error: "invalid mcp runner payload" },
    ]);
  });

  it("errors when the default export is not a fetch handler", async () => {
    const result = await runChild(`export default { name: "nope" };`, {});

    expect(result.frames).toEqual([
      {
        t: "error",
        error:
          "mcp server bundle default export must be a fetch handler (createMcpHandler)",
      },
    ]);
  });

  it("surfaces a thrown handler error on the request's own frame and keeps the batch", async () => {
    // A throw is that request's failure, like a 500 would be; the process is
    // not suspect, so the batch still closes on `end` and the child stays.
    const result = await runChild(
      `export default () => { throw new Error("boom"); };`,
      {},
    );

    expect(result.frames).toEqual([
      { t: "error", id: "1", error: "boom" },
      { t: "end" },
    ]);
    expect(result.exitCode).toBe(0);
  });

  it("fails the whole batch and retires on the deadline", async () => {
    const result = await runChild(
      `export default (request) => new Promise((resolve, reject) => {
         request.signal.addEventListener("abort", () => reject(request.signal.reason));
       });`,
      { requests: [{}, {}], env: { TOOL_RUNNER_TIMEOUT_SECONDS: "1" } },
    );

    expect(result.frames).toEqual([
      { t: "error", error: "mcp server run timed out" },
    ]);
    expect(result.exitCode).toBe(1);
  }, 10_000);

  it("gives a bundler's createRequire(import.meta.url) a usable file URL", async () => {
    // Bundlers emit this line whenever they inline a CommonJS dependency, and it
    // runs at module scope: a data: URL throws there, before the server exists.
    const result = await runChild(
      `import { createRequire } from 'node:module';
       const __require = createRequire(import.meta.url);
       const os = __require('os');
       export default () => new Response(JSON.stringify({
         scheme: import.meta.url.slice(0, 5),
         required: typeof os.platform(),
       }));`,
      {},
    );

    expect(JSON.parse(finalFrame(result.frames).result.body)).toEqual({
      scheme: "file:",
      required: "string",
    });
  });

  // CPU rides the batch's terminal frame so core can meter the invocation as
  // mcp-sandbox compute; a child that did real work always burns some.
  it("reports the batch's CPU on the terminal frame", async () => {
    const result = await runChild(
      `export default () => new Response("ok");`,
      {},
    );

    expect(result.terminalCpuUsec).toBeGreaterThan(0);
  });
});

interface ChildRequest {
  body?: string;
  headers?: Record<string, string>;
}

/** The one tagged final frame of a single-request batch. */
function finalFrame(frames: unknown[]): {
  t: "final";
  id: string;
  result: HostedResponse;
} {
  const finals = frames.filter(
    (frame) => (frame as { t: string }).t === "final",
  );
  expect(finals).toHaveLength(1);

  return finals[0] as { t: "final"; id: string; result: HostedResponse };
}

// One batch on stdin: `requests` sends several, otherwise the single request
// described by body/headers.
async function runChild(
  source: string,
  options: ChildRequest & {
    requests?: ChildRequest[];
    expectedSha256?: string;
    omitMode?: boolean;
    env?: Record<string, string>;
  },
): Promise<{
  frames: unknown[];
  terminalCpuUsec: number | undefined;
  exitCode: number | null;
}> {
  const expectedSha256 =
    options.expectedSha256 ??
    new Bun.CryptoHasher("sha256").update(source).digest("hex");
  // The fourth pipe is the bundle channel the handler writes; the batch on
  // stdin only addresses it.
  const child = spawn("node", [childRunnerPath], {
    stdio: ["pipe", "pipe", "pipe", "pipe"],
    env: { ...process.env, ...options.env },
  });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.resume();
  (child.stdio[3] as Writable).end(source);
  const requests = options.requests ?? [
    { body: options.body, headers: options.headers },
  ];
  child.stdin.end(
    `${JSON.stringify({
      ...(options.omitMode ? {} : { mode: "mcp" }),
      expectedSha256: expectedSha256,
      toolName: "server-under-test",
      requests: requests.map((request, index) => ({
        id: String(index + 1),
        mcpRequest: {
          method: "POST",
          headers: request.headers ?? {},
          ...(request.body !== undefined ? { body: request.body } : {}),
        },
      })),
    })}\n`,
  );
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });

  // cpuUsec rides the terminal frame for usage metering and is inherently
  // variable, so it is lifted out and the frame bodies stay exactly assertable.
  const frames = stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const terminal = frames.at(-1);
  const terminalCpuUsec =
    typeof terminal?.cpuUsec === "number" ? terminal.cpuUsec : undefined;

  return {
    frames: frames.map(({ cpuUsec: _cpuUsec, ...frame }) => frame),
    terminalCpuUsec: terminalCpuUsec,
    exitCode: exitCode,
  };
}
