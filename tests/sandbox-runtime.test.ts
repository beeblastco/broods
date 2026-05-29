import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";

import { handler as bashSandboxHandler } from "../functions/sandbox-bash/handler.ts";

describe("sandbox runtime lambdas", () => {
  const namespace = "fs-0123456789abcdef0123456789abcdef01234567";

  it("runs bash-like filesystem commands against a mounted workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandbox-bash-"));
    await mkdir(join(root, namespace), { recursive: true });

    const result = await bashSandboxHandler({
      runtime: "shell",
      namespace,
      workspaceRoot: root,
      shell: [
        "mkdir -p notes",
        "cat <<'EOF' > notes/a.txt",
        "hello mounted workspace",
        "EOF",
        "cat notes/a.txt | sed -n '1,1p'",
      ].join("\n"),
      timeoutSeconds: 5,
      outputLimitBytes: 4096,
    });

    expect(result).toMatchObject({
      ok: true,
      exitCode: 0,
      stdout: "hello mounted workspace\n",
      stderr: "",
    });
    await expect(readFile(join(root, namespace, "notes", "a.txt"), "utf8"))
      .resolves.toBe("hello mounted workspace\n");

    await rm(root, { recursive: true, force: true });
  });

  it("executes native Node from the bash sandbox", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandbox-bash-"));
    await mkdir(join(root, namespace), { recursive: true });
    await writeFile(
      join(root, namespace, "main.ts"),
      [
        "import { writeFileSync } from 'node:fs';",
        "const answer: number = 21 * 2;",
        "writeFileSync('answer.txt', String(answer));",
        "console.log(JSON.stringify({ answer, args: process.argv.slice(2) }));",
      ].join("\n"),
      "utf8",
    );

    const result = await bashSandboxHandler({
      runtime: "shell",
      namespace,
      workspaceRoot: root,
      shell: "node main.ts --mode fast",
      timeoutSeconds: 5,
      outputLimitBytes: 4096,
    });

    expect(result).toMatchObject({
      ok: true,
      exitCode: 0,
      stdout: "{\"answer\":42,\"args\":[\"--mode\",\"fast\"]}\n",
      stderr: "",
    });
    await expect(readFile(join(root, namespace, "answer.txt"), "utf8"))
      .resolves.toBe("42");

    await rm(root, { recursive: true, force: true });
  });

  it("injects configured env vars into shell commands and Node", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandbox-bash-"));
    await mkdir(join(root, namespace), { recursive: true });
    await writeFile(
      join(root, namespace, "env.js"),
      "console.log(process.env.MY_API_BASE ?? 'missing');",
      "utf8",
    );

    const result = await bashSandboxHandler({
      runtime: "shell",
      namespace,
      workspaceRoot: root,
      shell: "echo $MY_API_BASE && node env.js",
      timeoutSeconds: 5,
      outputLimitBytes: 4096,
      envVars: { MY_API_BASE: "https://api.example.com" },
    });

    expect(result).toMatchObject({
      ok: true,
      exitCode: 0,
      stdout: "https://api.example.com\nhttps://api.example.com\n",
    });

    await rm(root, { recursive: true, force: true });
  });

  it("does not leak host process env or reserved vars into Node", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandbox-bash-"));
    const originalSecret = process.env.SANDBOX_TEST_SECRET;
    process.env.SANDBOX_TEST_SECRET = "leaked";

    try {
      await mkdir(join(root, namespace), { recursive: true });
      await writeFile(
        join(root, namespace, "env.js"),
        [
          "console.log(JSON.stringify({",
          "  hostSecret: process.env.SANDBOX_TEST_SECRET ?? null,",
          "  home: process.env.HOME ?? null,",
          "}));",
        ].join("\n"),
        "utf8",
      );

      const result = await bashSandboxHandler({
        runtime: "shell",
        namespace,
        workspaceRoot: root,
        shell: "node env.js",
        timeoutSeconds: 5,
        outputLimitBytes: 4096,
        // A configured var trying to override a reserved one must not win.
        envVars: { HOME: "/hacked" },
      });

      expect(result).toMatchObject({
        ok: true,
        stdout: "{\"hostSecret\":null,\"home\":\"/tmp\"}\n",
      });
    } finally {
      if (originalSecret === undefined) {
        delete process.env.SANDBOX_TEST_SECRET;
      } else {
        process.env.SANDBOX_TEST_SECRET = originalSecret;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects invalid bash sandbox namespaces", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandbox-bash-"));

    const result = await bashSandboxHandler({
      runtime: "shell",
      namespace: "../outside",
      workspaceRoot: root,
      shell: "pwd",
      timeoutSeconds: 5,
      outputLimitBytes: 4096,
    });

    expect(result).toMatchObject({
      ok: false,
      exitCode: null,
      stdout: "",
      stderr: "Invalid workspace namespace",
    });

    await rm(root, { recursive: true, force: true });
  });
});
