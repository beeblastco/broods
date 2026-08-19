/**
 * Sandbox tool-runner handler regressions, driven under real Node (handler.mjs
 * spawns process.execPath). Containment: the runner Lambda is shared by every
 * account and its warm execution environment is reused across tenants, so a run
 * must leave nothing on disk and no live process behind. Delivery: frames must
 * reach the response stream as the child writes them, not in one final flush.
 */

import { describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const handlerPath = fileURLToPath(
  new URL("../../lambda/handler.mjs", import.meta.url),
);

// cpuUsec rides the terminal frame for usage metering and is inherently
// variable, so it is dropped here and the frame bodies stay exactly assertable.
function parseFrames(
  stdout: string | undefined,
): Array<Record<string, unknown> & { t: string }> {
  return (stdout ?? "")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const { cpuUsec: _cpuUsec, ...frame } = JSON.parse(line) as {
        t: string;
        cpuUsec?: number;
      };

      return frame;
    });
}

// A bundle the runner will accept: sha256 must match what the child recomputes.
async function invokeHandler(
  bundle: string,
  event: Record<string, unknown>,
  parentEnv: Record<string, string> = {},
  // Read the response slowly against a small buffer to force the handler's
  // backpressure path, where a paused stdout can outlive the child's exit.
  throttleMs = 0,
  // Address the bundle the way core does in production — a presigned GET the
  // handler resolves — instead of inlining the bytes in the invoke event.
  bundleAddress?: "served" | { url: string },
): Promise<{ stdout?: string; arrivalsMs?: number[] }> {
  const dir = await mkdtemp(join(tmpdir(), "broods-handler-drv-"));
  const server =
    bundleAddress === "served"
      ? Bun.serve({ port: 0, fetch: () => new Response(bundle) })
      : undefined;
  const bundleUrl =
    server?.url.href ??
    (bundleAddress && bundleAddress !== "served"
      ? bundleAddress.url
      : undefined);
  try {
    const driver = join(dir, "driver.mjs");
    await writeFile(
      driver,
      [
        // The handler streams NDJSON into a response stream instead of returning
        // it, so the driver collects the stream and re-emits it as { stdout },
        // timestamping each write so a test can tell streaming from buffering.
        `import { createHash } from "node:crypto";`,
        `import { PassThrough } from "node:stream";`,
        `import { handler } from ${JSON.stringify(handlerPath)};`,
        `const throttleMs = ${throttleMs};`,
        `const bundle = Buffer.from(${JSON.stringify(bundle)}, "utf8");`,
        `const responseStream = new PassThrough(`,
        `  throttleMs ? { highWaterMark: 64 } : {},`,
        `);`,
        `const startedAt = Date.now();`,
        `const arrivalsMs = [];`,
        `let stdout = "";`,
        `const consumed = (async () => {`,
        `  for await (const chunk of responseStream) {`,
        `    stdout += chunk;`,
        `    arrivalsMs.push(Date.now() - startedAt);`,
        `    if (throttleMs) await new Promise((r) => setTimeout(r, throttleMs));`,
        `  }`,
        `})();`,
        `await handler({`,
        `  ...${JSON.stringify(event)},`,
        `  ...${JSON.stringify(bundleUrl ? { bundleUrl: bundleUrl } : {})},`,
        bundleUrl ? `` : `  bundleSourceB64: bundle.toString("base64"),`,
        `  expectedSha256: createHash("sha256").update(bundle).digest("hex"),`,
        `}, responseStream);`,
        `await consumed;`,
        `process.stdout.write(JSON.stringify({ stdout, arrivalsMs }));`,
      ].join("\n"),
    );

    return await new Promise((resolve, reject) => {
      const child = spawn("node", [driver], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...parentEnv },
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (chunk) => (out += chunk));
      child.stderr.on("data", (chunk) => (err += chunk));
      child.once("error", reject);
      child.once("exit", () => {
        try {
          resolve(JSON.parse(out));
        } catch {
          reject(new Error(`driver produced no JSON: ${out}${err}`));
        }
      });
    });
  } finally {
    server?.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
}

describe("tool-runner containment", () => {
  it("never writes the tenant bundle to disk", async () => {
    // The bundle hunts its own source through TMPDIR/HOME. Nothing should match:
    // /tmp survives in a warm sandbox, so a bundle on disk outlives its run.
    const marker = "b7f2b1e4c0a94f8e_bundle_marker";
    const bundle = [
      `import { readdirSync, readFileSync } from "node:fs";`,
      `const marker = ${JSON.stringify(marker)};`,
      `function hunt(dir) {`,
      `  const hits = [];`,
      `  for (const entry of readdirSync(dir, { withFileTypes: true })) {`,
      `    const path = dir + "/" + entry.name;`,
      `    try {`,
      `      if (entry.isDirectory()) hits.push(...hunt(path));`,
      `      else if (readFileSync(path, "utf8").includes(marker)) hits.push(path);`,
      `    } catch {}`,
      `  }`,
      `  return hits;`,
      `}`,
      `export default {`,
      `  name: "hunter",`,
      `  execute() {`,
      `    return { hits: [...hunt(process.env.TMPDIR), ...hunt(process.env.HOME)] };`,
      `  },`,
      `};`,
    ].join("\n");

    const result = await invokeHandler(bundle, { toolName: "hunter" });
    const frames = parseFrames(result.stdout);

    expect(frames.at(-1)).toEqual({ t: "final", result: { hits: [] } });
  }, 30_000);

  it("hides the function's AWS credentials from the tenant bundle's env", async () => {
    // Scrubbing the child's env is not a boundary on its own (same-UID /proc
    // still reaches the parent), but the env copy itself must not carry through.
    const bundle = [
      `export default {`,
      `  name: "envprobe",`,
      `  execute() {`,
      `    return {`,
      `      secret: process.env.AWS_SECRET_ACCESS_KEY ?? null,`,
      `      token: process.env.AWS_SESSION_TOKEN ?? null,`,
      `      runtimeApi: process.env.AWS_LAMBDA_RUNTIME_API ?? null,`,
      `    };`,
      `  },`,
      `};`,
    ].join("\n");

    const result = await invokeHandler(
      bundle,
      { toolName: "envprobe" },
      {
        AWS_SECRET_ACCESS_KEY: "shouldnotleak",
        AWS_SESSION_TOKEN: "shouldnotleak",
        AWS_LAMBDA_RUNTIME_API: "127.0.0.1:9001",
      },
    );
    const frames = parseFrames(result.stdout);

    expect(frames.at(-1)).toEqual({
      t: "final",
      result: { secret: null, token: null, runtimeApi: null },
    });
  }, 30_000);

  it("passes configured secrets only through tool context, never process.env", async () => {
    const bundle = [
      `export default {`,
      `  name: "configured",`,
      `  execute(_input, options) {`,
      `    return {`,
      `      configured: options.context.config.apiToken,`,
      `      leaked: process.env.ACCOUNT_TOOL_API_TOKEN ?? null,`,
      `    };`,
      `  },`,
      `};`,
    ].join("\n");

    const result = await invokeHandler(
      bundle,
      {
        toolName: "configured",
        config: { apiToken: "scoped-tool-secret" },
      },
      { ACCOUNT_TOOL_API_TOKEN: "parent-secret-must-not-leak" },
    );
    const frames = parseFrames(result.stdout);

    expect(frames.at(-1)).toEqual({
      t: "final",
      result: { configured: "scoped-tool-secret", leaked: null },
    });
  }, 30_000);

  it("reaps a process the tenant bundle leaves running", async () => {
    // A survivor in a warm sandbox outlives the invocation and sees the next
    // tenant's run. handler.mjs kills the child's whole process group.
    const dir = await mkdtemp(join(tmpdir(), "broods-survivor-"));
    try {
      const marker = join(dir, "survived.txt");
      const bundle = [
        `import { spawn } from "node:child_process";`,
        `export default {`,
        `  name: "spawner",`,
        `  execute() {`,
        `    const code = "setTimeout(() => require('fs').writeFileSync(" +`,
        `      ${JSON.stringify(JSON.stringify(marker))} + ", 'survived'), 1500)";`,
        `    spawn(process.execPath, ["-e", code], { stdio: "ignore" });`,
        `    return { spawned: true };`,
        `  },`,
        `};`,
      ].join("\n");

      const result = await invokeHandler(bundle, { toolName: "spawner" });
      expect(result.stdout).toContain('"spawned":true');

      await new Promise((resolve) => setTimeout(resolve, 3_000));
      expect(existsSync(marker)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("tool-runner bundle addressing", () => {
  it("resolves a bundle the event only addresses by URL", async () => {
    // Core spends its 6 MB invoke quota on a presigned GET rather than the
    // bytes; the handler fetches so the per-invocation child does not.
    const bundle = `export default { name: "byurl", execute: () => ({ ok: true }) };`;

    const result = await invokeHandler(
      bundle,
      { toolName: "byurl" },
      {},
      0,
      "served",
    );

    expect(parseFrames(result.stdout)).toEqual([
      { t: "final", result: { ok: true } },
    ]);
  }, 30_000);

  it("fails loudly when the bundle URL is refused", async () => {
    // What an expired presigned URL looks like: the run has to end on an error
    // frame rather than hang or report an empty result.
    const result = await invokeHandler(
      "export default {};",
      { toolName: "expired" },
      {},
      0,
      { url: "https://example.invalid/expired-bundle.mjs" },
    );
    const frames = (result.stdout ?? "")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { t: string });

    expect(frames).toHaveLength(1);
    expect(frames[0]?.t).toBe("error");
  }, 30_000);
});

describe("tool-runner response streaming", () => {
  it("forwards each yield as the child writes it, not in one final flush", async () => {
    // The bundle stalls between yields. A buffering handler delivers everything
    // at the end, so every arrival lands within a few ms of the last one.
    const bundle = [
      `const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));`,
      `export default {`,
      `  name: "ticker",`,
      `  async *execute() {`,
      `    yield { tick: 1 };`,
      `    await sleep(700);`,
      `    yield { tick: 2 };`,
      `  },`,
      `};`,
    ].join("\n");

    const result = await invokeHandler(bundle, { toolName: "ticker" });
    const arrivals = result.arrivalsMs ?? [];
    const frames = parseFrames(result.stdout);

    expect(frames).toEqual([
      { t: "chunk", output: { tick: 1 } },
      { t: "chunk", output: { tick: 2 } },
      { t: "final", result: { tick: 2 } },
    ]);
    expect(arrivals.length).toBeGreaterThan(1);
    expect(arrivals.at(-1)! - arrivals[0]!).toBeGreaterThan(500);
  }, 30_000);

  it("loses nothing when the reader is slower than the tool", async () => {
    // Backpressure pauses child stdout, and a paused pipe still holds data when
    // the child exits — so finalizing on "exit" silently truncates the run.
    const yields = 2000;
    const bundle = [
      `export default {`,
      `  name: "chatty",`,
      `  async *execute() {`,
      `    for (let i = 0; i < ${yields}; i++) yield { i: i, pad: "x".repeat(400) };`,
      `  },`,
      `};`,
    ].join("\n");

    const result = await invokeHandler(bundle, { toolName: "chatty" }, {}, 5);
    const frames = (result.stdout ?? "")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { t: string });

    expect(frames.filter((frame) => frame.t === "chunk")).toHaveLength(yields);
    expect(frames.at(-1)?.t).toBe("final");
  }, 30_000);

  it("settles promptly when a grandchild inherits the stdout pipe", async () => {
    // The grandchild holds the pipe's write end open, so stdout never ends on
    // its own. Waiting for it without reaping the group first would stall the
    // run until the 30s kill, turning a fast tool into a timeout.
    const bundle = [
      `import { spawn } from "node:child_process";`,
      `export default {`,
      `  name: "leaky",`,
      `  execute() {`,
      // inherit: the grandchild gets this process's stdout, not a fresh pipe.
      `    spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], {`,
      `      stdio: "inherit",`,
      `    });`,
      `    return { spawned: true };`,
      `  },`,
      `};`,
    ].join("\n");

    const startedAt = Date.now();
    const result = await invokeHandler(bundle, { toolName: "leaky" });

    expect(result.stdout).toContain('"spawned":true');
    expect(Date.now() - startedAt).toBeLessThan(15_000);
  }, 40_000);
});
