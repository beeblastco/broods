import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import editTool from "../src/harness/tools/edit.tool.ts";
import globTool from "../src/harness/tools/glob.tool.ts";
import type { SandboxToolContext } from "../src/harness/tools/filesystem-utils.ts";

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_ENV = { ...process.env };
const root = mkdtempSync(join(tmpdir(), "shell-only-"));
const scripts: string[] = [];
// Set to a byte count, the stand-in cuts stdout there and says so, as the Worker's cap does.
let outputCap: number | undefined;

// A Worker stand-in: runs each script in real bash with no node on PATH, like just-bash.
beforeAll((): void => {
  process.env.CLOUDFLARE_WORKER_URL = "http://127.0.0.1:9";
  process.env.CLOUDFLARE_WORKER_API_KEY = "key";
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const { script } = JSON.parse(init.body as string) as { script: string };
    scripts.push(script);
    const run = Bun.spawnSync(["bash", "-c", script], {
      cwd: root,
      env: { PATH: "/usr/bin:/bin" },
    });

    return Response.json({
      ok: run.exitCode === 0,
      exit_code: run.exitCode,
      timed_out: false,
      truncated: outputCap !== undefined,
      stdout: run.stdout.toString().slice(0, outputCap),
      stderr: run.stderr.toString(),
      duration_ms: 1,
    });
  }) as typeof fetch;
});

afterAll((): void => {
  globalThis.fetch = ORIGINAL_FETCH;
  process.env = ORIGINAL_ENV;
  rmSync(root, { recursive: true, force: true });
});

const context = {
  workspaces: [
    {
      name: "project",
      workspaceId: "ws_a",
      namespace: "fs-test",
      config: { storage: { provider: "disk" } },
      sandbox: { provider: "worker", network: { mode: "deny-all" } },
    },
  ],
} as unknown as SandboxToolContext;
type Runnable = { execute(input: Record<string, unknown>): Promise<unknown> };

describe("file tools on a shell-only sandbox", () => {
  it("edit reads, replaces in core and writes back, with no node", async () => {
    writeFileSync(join(root, "a.ts"), "const a = 1;\nconst b = 1;\n");
    const edit = editTool(context).edit as unknown as Runnable;

    const out = await edit.execute({
      file_path: "a.ts",
      old_string: "a = 1",
      new_string: "a = 2",
    });

    expect(String(out)).toBe("Edited a.ts (1 replacement)");
    expect(readFileSync(join(root, "a.ts"), "utf8")).toBe(
      "const a = 2;\nconst b = 1;\n",
    );
    expect(scripts.some((script) => script.includes("node"))).toBe(false);
    await expect(
      edit.execute({
        file_path: "a.ts",
        old_string: "const",
        new_string: "let",
      }),
    ).rejects.toThrow("not unique");
  });

  it("edit refuses a read cut at the output cap instead of writing back the prefix", async () => {
    writeFileSync(join(root, "big.ts"), "const a = 1;\n".repeat(100));
    const edit = editTool(context).edit as unknown as Runnable;
    outputCap = 40;

    await expect(
      edit.execute({
        file_path: "big.ts",
        old_string: "a = 1",
        new_string: "a = 2",
        replace_all: true,
      }),
    ).rejects.toThrow("too large to edit here");
    outputCap = undefined;
    expect(readFileSync(join(root, "big.ts"), "utf8")).toBe(
      "const a = 1;\n".repeat(100),
    );
  });

  it("glob lists with find and matches in core", async () => {
    const glob = globTool(context).glob as unknown as Runnable;

    const out = await glob.execute({ pattern: "**/*.ts" });

    expect(JSON.stringify(out)).toContain("a.ts");
  });
});
