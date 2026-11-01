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

interface HostedResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

// cpuUsec varies run to run, so it is dropped to keep frame bodies exactly assertable.
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

function finalBody(stdout: string | undefined): unknown {
  const frames = parseFrames(stdout) as Array<{
    t: string;
    result?: HostedResponse;
  }>;
  expect(frames.at(-1)?.t).toBe("end");
  const finals = frames.filter((frame) => frame.t === "final");
  expect(finals).toHaveLength(1);

  return JSON.parse(finals[0]!.result!.body);
}

// Signal 0 only checks the pid exists; an unreaped zombie (stat `Z`) passes, so it counts as gone.
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const stat = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)]).stdout;

  return !stat.toString().trim().startsWith("Z");
}

async function invokeHandler(
  bundle: string,
  parentEnv: Record<string, string> = {},
  // Slow reads against a small buffer force the handler's backpressure path.
  throttleMs = 0,
  // As core does in production: a presigned GET the handler resolves, not inline bytes.
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
  const event = {
    mode: "mcp",
    toolName: "server-under-test",
    requests: [
      { id: "1", mcpRequest: { method: "POST", headers: {}, body: "{}" } },
    ],
  };
  try {
    const driver = join(dir, "driver.mjs");
    await writeFile(
      driver,
      [
        // The driver collects the handler's NDJSON stream, timestamping each write.
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
    await server?.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
}

describe("mcp-runner containment", () => {
  it("never writes the tenant bundle to disk", async () => {
    // /tmp survives in a warm sandbox, so a bundle on disk would outlive its run.
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
      `export default () => new Response(JSON.stringify({`,
      `  hits: [...hunt(process.env.TMPDIR), ...hunt(process.env.HOME)],`,
      `}));`,
    ].join("\n");

    const result = await invokeHandler(bundle);

    expect(finalBody(result.stdout)).toEqual({ hits: [] });
  }, 30_000);

  it("hides the function's AWS credentials from the tenant bundle's env", async () => {
    // Scrubbing the child's env is not a boundary on its own (same-UID /proc
    // still reaches the parent), but the env copy itself must not carry through.
    const bundle = [
      `export default () => new Response(JSON.stringify({`,
      `  secret: process.env.AWS_SECRET_ACCESS_KEY ?? null,`,
      `  token: process.env.AWS_SESSION_TOKEN ?? null,`,
      `  runtimeApi: process.env.AWS_LAMBDA_RUNTIME_API ?? null,`,
      `}));`,
    ].join("\n");

    const result = await invokeHandler(bundle, {
      AWS_SECRET_ACCESS_KEY: "shouldnotleak",
      AWS_SESSION_TOKEN: "shouldnotleak",
      AWS_LAMBDA_RUNTIME_API: "127.0.0.1:9001",
    });

    expect(finalBody(result.stdout)).toEqual({
      secret: null,
      token: null,
      runtimeApi: null,
    });
  }, 30_000);

  it("reaps a process the tenant bundle leaves running", async () => {
    // A survivor in a warm sandbox would see the next tenant's run: the whole group is killed.
    const dir = await mkdtemp(join(tmpdir(), "broods-survivor-"));
    try {
      const marker = join(dir, "survived.txt");
      const bundle = [
        `import { spawn } from "node:child_process";`,
        `export default () => {`,
        `  const code = "setTimeout(() => require('fs').writeFileSync(" +`,
        `    ${JSON.stringify(JSON.stringify(marker))} + ", 'survived'), 1500)";`,
        `  const survivor = spawn(process.execPath, ["-e", code], { stdio: "ignore" });`,
        `  return new Response(JSON.stringify({ spawned: true, pid: survivor.pid }));`,
        `};`,
      ].join("\n");

      const result = await invokeHandler(bundle);
      const body = finalBody(result.stdout) as {
        spawned: boolean;
        pid: number;
      };
      expect(body).toEqual({ spawned: true, pid: expect.any(Number) });

      // Gone well before its 1.5 s timer, so it never writes the marker.
      const deadline = performance.now() + 1_000;
      while (isAlive(body.pid)) {
        if (performance.now() > deadline)
          throw new Error("survivor still running");
        await Bun.sleep(10);
      }
      expect(existsSync(marker)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("mcp-runner bundle addressing", () => {
  it("resolves a bundle the event only addresses by URL", async () => {
    // Core spends its 6 MB invoke quota on a presigned GET rather than the bytes.
    const bundle = `export default () => new Response(JSON.stringify({ ok: true }));`;

    const result = await invokeHandler(bundle, {}, 0, "served");

    expect(finalBody(result.stdout)).toEqual({ ok: true });
  }, 30_000);

  it("fails loudly when the bundle URL is refused", async () => {
    // An expired presigned URL must end on an error frame, not hang or report an empty result.
    const result = await invokeHandler("export default {};", {}, 0, {
      url: "https://example.invalid/expired-bundle.mjs",
    });
    const frames = (result.stdout ?? "")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { t: string });

    expect(frames).toHaveLength(1);
    expect(frames[0]?.t).toBe("error");
  }, 30_000);
});

describe("mcp-runner response delivery", () => {
  it("loses nothing when the reader is slower than the response", async () => {
    // A paused pipe still holds data when the child exits, so finalizing on "exit" truncates.
    const bundle = [
      `export default () => new Response(JSON.stringify({`,
      `  pad: "x".repeat(600_000),`,
      `}));`,
    ].join("\n");

    const result = await invokeHandler(bundle, {}, 5);
    const body = finalBody(result.stdout) as { pad: string };

    expect(body.pad).toHaveLength(600_000);
  }, 30_000);

  it("settles promptly when a grandchild inherits the stdout pipe", async () => {
    // The grandchild holds the stdout write end open: unless the group is reaped first, the run
    // waits for the 30s kill.
    const bundle = [
      `import { spawn } from "node:child_process";`,
      `export default () => {`,
      `  spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], {`,
      `    stdio: "inherit",`,
      `  });`,
      `  return new Response(JSON.stringify({ spawned: true }));`,
      `};`,
    ].join("\n");

    const startedAt = Date.now();
    const result = await invokeHandler(bundle);

    expect(finalBody(result.stdout)).toEqual({ spawned: true });
    expect(Date.now() - startedAt).toBeLessThan(15_000);
  }, 40_000);
});
