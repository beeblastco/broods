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
import { positionalArgs } from "../src/cli/utils.ts";

test("init writes gitignore entries for generated folders", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "broods-cli-init-"));
  try {
    const proc = Bun.spawn({
      cmd: [
        process.execPath,
        new URL("../src/cli/index.ts", import.meta.url).pathname,
        "init",
        "--force",
      ],
      cwd: cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        BROODS_DASHBOARD_URL: "https://dashboard.example",
      },
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error(await new Response(proc.stderr).text());
    }

    const gitignore = await readFile(join(cwd, "broods", ".gitignore"), "utf8");

    expect(gitignore).toBe("_generated\n.cache\n");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("formatDiffEntries prints nothing for no changes", () => {
  expect(formatDiffEntries([], { color: false })).toEqual([]);
});

test("formatDiffEntries renders create, rename, update, and delete labels", () => {
  const lines = formatDiffEntries(
    [
      { operation: "create", kind: "agent", name: "support" },
      {
        operation: "rename",
        kind: "agent",
        previousName: "old-support",
        name: "support",
      },
      { operation: "update", kind: "workspace", name: "repo" },
      { operation: "delete", kind: "sandbox", name: "old" },
    ],
    { color: false },
  );

  expect(lines).toEqual([
    "  [+] agent:support",
    "  [~] agent:old-support -> support",
    "  [*] workspace:repo",
    "  [-] sandbox:old",
  ]);
});

test("formatDiffEntries colors create, rename, update, and delete markers", () => {
  const lines = formatDiffEntries(
    [
      { operation: "create", kind: "agent", name: "support" },
      {
        operation: "rename",
        kind: "agent",
        previousName: "old-support",
        name: "support",
      },
      { operation: "update", kind: "workspace", name: "repo" },
      { operation: "delete", kind: "sandbox", name: "old" },
    ],
    { color: true },
  );

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

test("formatDeploymentTarget includes project, stage, and dashboard URL", () => {
  const output = formatDeploymentTarget(
    {
      project: "sandbox-stateless",
      stage: "development",
      dashboardUrl: "https://dashboard.dev.broods.app",
    },
    { color: false },
  );

  expect(output).toContain("▌ Syncing Development: sandbox-stateless");
  expect(output).toContain("[Development] development (dashboard)");
  expect(output).toContain(
    "▌ └─ https://dashboard.dev.broods.app?project=sandbox-stateless&stage=development",
  );
});

// `broods stage use staging` + `broods dev` syncs staging, so the banner has to
// name staging. It used to hardcode "Development" and mislabel every other
// stage, including Production.
test("formatDeploymentTarget names the stage it is actually syncing", () => {
  const output = formatDeploymentTarget(
    {
      project: "sandbox-stateless",
      stage: "staging",
      dashboardUrl: "https://dashboard.dev.broods.app",
    },
    { color: false },
  );

  expect(output).toContain("▌ Syncing staging: sandbox-stateless");
  expect(output).toContain("[staging] staging (dashboard)");
  expect(output).not.toContain("Development");
  expect(output).toContain("?project=sandbox-stateless&stage=staging");
});

test("formatDeploymentTarget canonicalizes the reserved stage names", () => {
  const output = formatDeploymentTarget(
    {
      project: "sandbox-stateless",
      stage: "production",
      dashboardUrl: "https://dashboard.dev.broods.app",
    },
    { color: false },
  );

  expect(output).toContain("▌ Syncing Production: sandbox-stateless");
  expect(output).toContain("[Production] production (dashboard)");
});

// Green reads as "routine dev sync", so only Development may claim it.
test("formatDeploymentTarget drops the green badge outside Development", () => {
  const development = formatDeploymentTarget(
    {
      project: "app",
      stage: "development",
      dashboardUrl: "https://dashboard.dev.broods.app",
    },
    { color: true },
  );
  const production = formatDeploymentTarget(
    {
      project: "app",
      stage: "production",
      dashboardUrl: "https://dashboard.dev.broods.app",
    },
    { color: true },
  );

  expect(development).toContain("\x1b[42m");
  expect(production).not.toContain("\x1b[42m");
  expect(production).toContain("\x1b[43m");
});

test("formatEnvSync lists the synced env var names", () => {
  const line = formatEnvSync(["OPENAI_API_KEY", "STRIPE_API_KEY"], {
    color: false,
  });

  expect(line).toBe(
    "▌ ↑ Synced 2 env var(s) from .env.local: OPENAI_API_KEY, STRIPE_API_KEY",
  );
});

test("formatWarning renders yellow warning output", () => {
  expect(formatWarning("⚠ Heads up", { color: false })).toBe("⚠ Heads up");
  expect(formatWarning("⚠ Heads up", { color: true })).toBe(
    "\x1b[33m⚠ Heads up\x1b[0m",
  );
});

test("positionalArgs drops option values so they cannot become a run prompt", () => {
  expect(positionalArgs(["my-agent", "--project", "foo"])).toEqual([
    "my-agent",
  ]);
  expect(positionalArgs(["my-agent", "-n", "50", "hello"])).toEqual([
    "my-agent",
    "hello",
  ]);
  expect(positionalArgs(["my-agent", "--prune", "say", "hi"])).toEqual([
    "my-agent",
    "say",
    "hi",
  ]);
});
