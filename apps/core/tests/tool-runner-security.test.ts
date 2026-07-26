/**
 * Sandbox tool-runner containment regressions. The runner Lambda is shared by
 * every account, so its warm execution environment is reused across tenants:
 * these assert that a run leaves nothing on disk and no live process behind.
 * Driven under real Node (handler.mjs spawns process.execPath).
 */

import { describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const handlerPath = fileURLToPath(
  new URL("../src/harness/sandbox/tool-runner/handler.mjs", import.meta.url),
);

// A bundle the runner will accept: sha256 must match what the child recomputes.
async function invokeHandler(
  bundle: string,
  event: Record<string, unknown>,
  parentEnv: Record<string, string> = {},
): Promise<{ stdout?: string; error?: string }> {
  const dir = await mkdtemp(join(tmpdir(), "broods-handler-drv-"));
  try {
    const driver = join(dir, "driver.mjs");
    await writeFile(
      driver,
      [
        `import { createHash } from "node:crypto";`,
        `import { handler } from ${JSON.stringify(handlerPath)};`,
        `const bundle = Buffer.from(${JSON.stringify(bundle)}, "utf8");`,
        `const result = await handler({`,
        `  ...${JSON.stringify(event)},`,
        `  bundleSourceB64: bundle.toString("base64"),`,
        `  expectedSha256: createHash("sha256").update(bundle).digest("hex"),`,
        `});`,
        `process.stdout.write(JSON.stringify(result));`,
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
    const frames = (result.stdout ?? "")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

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
    const frames = (result.stdout ?? "")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(frames.at(-1)).toEqual({
      t: "final",
      result: { secret: null, token: null, runtimeApi: null },
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
