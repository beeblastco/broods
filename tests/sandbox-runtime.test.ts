import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";

import { handler as nodeSandboxHandler } from "../functions/sandbox-node/handler.ts";

describe("sandbox runtime lambdas", () => {
  const namespace = "fs-0123456789abcdef0123456789abcdef01234567";

  it("executes JavaScript with the current runtime binary", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandbox-runtime-"));
    await mkdir(join(root, namespace), { recursive: true });
    await writeFile(
      join(root, namespace, "main.js"),
      "console.log(JSON.stringify({ language: 'javascript', answer: 21 * 2 }));",
      "utf8",
    );

    const result = await nodeSandboxHandler({
      runtime: "node",
      namespace,
      entryPath: "/main.js",
      workspaceRoot: root,
      args: [],
      timeoutSeconds: 5,
      outputLimitBytes: 4096,
    });

    expect(result).toMatchObject({
      ok: true,
      runtime: "node",
      exitCode: 0,
      stdout: "{\"language\":\"javascript\",\"answer\":42}\n",
      stderr: "",
      timedOut: false,
      truncated: false,
    });

    await rm(root, { recursive: true, force: true });
  });

  it("transpiles TypeScript inside the mounted workspace before execution", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandbox-runtime-"));
    await mkdir(join(root, namespace), { recursive: true });
    await writeFile(
      join(root, namespace, "main.ts"),
      "const answer: number = 21 * 2;\nconsole.log(JSON.stringify({ language: 'typescript', answer }));",
      "utf8",
    );

    const result = await nodeSandboxHandler({
      runtime: "node",
      namespace,
      entryPath: "/main.ts",
      workspaceRoot: root,
      args: [],
      timeoutSeconds: 5,
      outputLimitBytes: 4096,
    });

    expect(result).toMatchObject({
      ok: true,
      runtime: "node",
      exitCode: 0,
      stdout: "{\"language\":\"typescript\",\"answer\":42}\n",
      stderr: "",
    });

    await rm(root, { recursive: true, force: true });
  });

  it("runs from the namespace root so relative reads, writes, and args behave like bash", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandbox-runtime-"));
    await mkdir(join(root, namespace, "scripts"), { recursive: true });
    await writeFile(join(root, namespace, "input.txt"), "mounted workspace", "utf8");
    await writeFile(
      join(root, namespace, "scripts", "process.js"),
      [
        "const fs = require('node:fs');",
        "const input = fs.readFileSync('input.txt', 'utf8');",
        "fs.writeFileSync('output.txt', `${input}:${process.argv.slice(2).join(',')}`);",
        "console.log(JSON.stringify({ input, args: process.argv.slice(2) }));",
      ].join("\n"),
      "utf8",
    );

    const result = await nodeSandboxHandler({
      runtime: "node",
      namespace,
      entryPath: "/scripts/process.js",
      workspaceRoot: root,
      args: ["--mode", "fast"],
      timeoutSeconds: 5,
      outputLimitBytes: 4096,
    });

    expect(result).toMatchObject({
      ok: true,
      exitCode: 0,
      stdout: "{\"input\":\"mounted workspace\",\"args\":[\"--mode\",\"fast\"]}\n",
    });
    await expect(readFile(join(root, namespace, "output.txt"), "utf8"))
      .resolves.toBe("mounted workspace:--mode,fast");

    await rm(root, { recursive: true, force: true });
  });

  it("rejects traversal entry paths before spawning child code", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandbox-runtime-"));
    await mkdir(join(root, namespace), { recursive: true });

    const result = await nodeSandboxHandler({
      runtime: "node",
      namespace,
      entryPath: "/../outside.js",
      workspaceRoot: root,
      args: [],
      timeoutSeconds: 5,
      outputLimitBytes: 4096,
    });

    expect(result).toMatchObject({
      ok: false,
      runtime: "node",
      exitCode: null,
      stdout: "",
      stderr: "Invalid entry path: resolved outside workspace root",
    });

    await rm(root, { recursive: true, force: true });
  });

  it("does not pass AWS credentials into child processes", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandbox-runtime-"));
    const originalAwsAccessKeyId = process.env.AWS_ACCESS_KEY_ID;
    const originalAwsSecretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
    process.env.AWS_ACCESS_KEY_ID = "test-access-key";
    process.env.AWS_SECRET_ACCESS_KEY = "test-secret-key";

    try {
      await mkdir(join(root, namespace), { recursive: true });
      await writeFile(
        join(root, namespace, "env.js"),
        [
          "console.log(JSON.stringify({",
          "  accessKey: process.env.AWS_ACCESS_KEY_ID ?? null,",
          "  secretKey: process.env.AWS_SECRET_ACCESS_KEY ?? null,",
          "  sessionToken: process.env.AWS_SESSION_TOKEN ?? null,",
          "}));",
        ].join("\n"),
        "utf8",
      );

      const result = await nodeSandboxHandler({
        runtime: "node",
        namespace,
        entryPath: "/env.js",
        workspaceRoot: root,
        args: [],
        timeoutSeconds: 5,
        outputLimitBytes: 4096,
      });

      expect(result).toMatchObject({
        ok: true,
        stdout: "{\"accessKey\":null,\"secretKey\":null,\"sessionToken\":null}\n",
      });
    } finally {
      if (originalAwsAccessKeyId === undefined) {
        delete process.env.AWS_ACCESS_KEY_ID;
      } else {
        process.env.AWS_ACCESS_KEY_ID = originalAwsAccessKeyId;
      }
      if (originalAwsSecretAccessKey === undefined) {
        delete process.env.AWS_SECRET_ACCESS_KEY;
      } else {
        process.env.AWS_SECRET_ACCESS_KEY = originalAwsSecretAccessKey;
      }
      await rm(root, { recursive: true, force: true });
    }
  });
});
