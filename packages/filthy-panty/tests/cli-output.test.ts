import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  formatDeploymentTarget,
  formatDiffEntries,
  formatEnvSync,
  formatReadyLine,
  formatWarning,
} from "../src/cli/output.ts";

test("init writes gitignore entries for generated folders", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "filthy-panty-cli-init-"));
  try {
    const proc = Bun.spawn({
      cmd: [process.execPath, new URL("../src/cli/index.ts", import.meta.url).pathname, "init", "--force"],
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        FILTHY_PANTY_DASHBOARD_URL: "https://dashboard.example",
      },
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error(await new Response(proc.stderr).text());
    }

    const gitignore = await readFile(join(cwd, "filthypanty", ".gitignore"), "utf8");

    expect(gitignore).toBe("_generated\n.cache\n");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("formatDiffEntries prints nothing for no changes", () => {
  expect(formatDiffEntries([], { color: false })).toEqual([]);
});

test("formatDiffEntries renders create, rename, update, and delete labels", () => {
  const lines = formatDiffEntries([
    { operation: "create", kind: "agent", name: "support" },
    { operation: "rename", kind: "agent", previousName: "old-support", name: "support" },
    { operation: "update", kind: "workspace", name: "repo" },
    { operation: "delete", kind: "sandbox", name: "old" },
  ], { color: false });

  expect(lines).toEqual([
    "  [+] agent:support",
    "  [~] agent:old-support -> support",
    "  [*] workspace:repo",
    "  [-] sandbox:old",
  ]);
});

test("formatDiffEntries colors create, rename, update, and delete markers", () => {
  const lines = formatDiffEntries([
    { operation: "create", kind: "agent", name: "support" },
    { operation: "rename", kind: "agent", previousName: "old-support", name: "support" },
    { operation: "update", kind: "workspace", name: "repo" },
    { operation: "delete", kind: "sandbox", name: "old" },
  ], { color: true });

  expect(lines[0]).toBe("  [\x1b[32m+\x1b[0m] agent:support");
  expect(lines[1]).toBe("  [\x1b[33m~\x1b[0m] agent:old-support -> support");
  expect(lines[2]).toBe("  [\x1b[36m*\x1b[0m] workspace:repo");
  expect(lines[3]).toBe("  [\x1b[31m-\x1b[0m] sandbox:old");
});

test("formatReadyLine includes a checkmark, time, message, and duration", () => {
  const line = formatReadyLine(3110, {
    color: false,
    now: new Date(2026, 5, 14, 20, 5, 32),
  });

  expect(line).toBe("✔ 20:05:32 Resources ready! (3.11s)");
});

test("formatDeploymentTarget includes project, environment, and dashboard URL", () => {
  const output = formatDeploymentTarget({
    project: "sandbox-stateless",
    environment: "development",
    dashboardUrl: "https://dashboard.dev.beeblast.co",
  }, { color: false });

  expect(output).toContain("▌ Syncing Development: sandbox-stateless");
  expect(output).toContain("[Development] development (dashboard)");
  expect(output).toContain("▌ └─ https://dashboard.dev.beeblast.co?project=sandbox-stateless&env=development");
});

test("formatEnvSync lists the synced env var names", () => {
  const line = formatEnvSync(["OPENAI_API_KEY", "STRIPE_API_KEY"], { color: false });

  expect(line).toBe("▌ ↑ Synced 2 env var(s) from .env.local: OPENAI_API_KEY, STRIPE_API_KEY");
});

test("formatWarning renders yellow warning output", () => {
  expect(formatWarning("⚠ Heads up", { color: false })).toBe("⚠ Heads up");
  expect(formatWarning("⚠ Heads up", { color: true })).toBe("\x1b[33m⚠ Heads up\x1b[0m");
});
