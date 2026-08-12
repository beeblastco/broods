import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * End-to-end coverage for `broods stage use`, which rewrites both BROODS_STAGE
 * and the per-stage BROODS_API_KEY in `.env.local`. The runtime key is the guard
 * against a stale key serving the stage the CLI just left, so its failure paths
 * matter as much as the happy one.
 */

const CLI = new URL("../src/cli/index.ts", import.meta.url).pathname;

const STAGES = [
  {
    id: "stg_dev",
    name: "Development",
    kind: "development",
    isDefault: true,
    agentCount: 1,
    variableCount: 0,
    updatedAt: 1,
  },
  {
    id: "stg_staging",
    name: "staging",
    kind: "custom",
    isDefault: false,
    agentCount: 1,
    variableCount: 2,
    updatedAt: 2,
  },
];

const servers: Array<{ stop: () => void }> = [];
const workdirs: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop();
  for (const dir of workdirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

/** A fake control plane serving just the two routes `stage use` calls. */
function serveBackend(runtimeKey: () => Response): string {
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/v1/account/stages") {
        return Response.json({ stages: STAGES });
      }
      if (url.pathname.endsWith("/runtime-key")) return runtimeKey();

      return new Response("not found", { status: 404 });
    },
  });
  servers.push(server);

  return `http://127.0.0.1:${server.port}`;
}

async function projectDir(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "broods-stage-use-"));
  workdirs.push(cwd);
  await writeFile(
    join(cwd, ".env.local"),
    [
      "# Local broods CLI settings.",
      'BROODS_PROJECT="demo-app"',
      'BROODS_STAGE="development"',
      'BROODS_API_KEY="fp_old_key"',
      "",
    ].join("\n"),
    "utf8",
  );

  return cwd;
}

async function runStageUse(
  cwd: string,
  baseUrl: string,
  extraEnv: Record<string, string> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn({
    cmd: [process.execPath, CLI, "stage", "use", "staging"],
    cwd: cwd,
    stdout: "pipe",
    stderr: "pipe",
    // A deliberately minimal env: inheriting the runner's BROODS_* vars would
    // shadow `.env.local` and silently change what this test exercises.
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      BROODS_TOKEN: "tok",
      BROODS_BASE_URL: baseUrl,
      ...extraEnv,
    },
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  return { exitCode: exitCode, stdout: stdout, stderr: stderr };
}

test("stage use writes the stage and repoints BROODS_API_KEY", async () => {
  const cwd = await projectDir();
  const baseUrl = serveBackend(() =>
    Response.json({ apiKey: "fp_new_key", keyHint: "fp_…_key" }),
  );

  const result = await runStageUse(cwd, baseUrl);
  const envLocal = await readFile(join(cwd, ".env.local"), "utf8");

  expect(result.exitCode).toBe(0);
  expect(envLocal).toContain('BROODS_STAGE="staging"');
  expect(envLocal).toContain('BROODS_API_KEY="fp_new_key"');
  expect(envLocal).not.toContain("fp_old_key");
  expect(result.stdout).toContain("Wrote BROODS_API_KEY");
});

// The stage exists but was never synced from here, so there is no key to copy.
// Overwriting with nothing, or aborting after BROODS_STAGE was already written,
// would both leave the project in a worse state than warning does.
test("stage use warns and keeps the old key when the stage has no runtime key", async () => {
  const cwd = await projectDir();
  const baseUrl = serveBackend(() => new Response("", { status: 404 }));

  const result = await runStageUse(cwd, baseUrl);
  const envLocal = await readFile(join(cwd, ".env.local"), "utf8");

  expect(result.exitCode).toBe(0);
  expect(envLocal).toContain('BROODS_STAGE="staging"');
  expect(envLocal).toContain('BROODS_API_KEY="fp_old_key"');
  expect(result.stdout).toContain("not synced here yet");
});

// Regression: a transport failure used to escape `syncRuntimeKeyForScope`, so
// the command exited 1 with a raw HTTP error even though BROODS_STAGE had
// already been switched — the user saw a failure that had partly succeeded.
test("stage use survives a runtime-key lookup failure", async () => {
  const cwd = await projectDir();
  const baseUrl = serveBackend(
    () => new Response("upstream exploded", { status: 500 }),
  );

  const result = await runStageUse(cwd, baseUrl);
  const envLocal = await readFile(join(cwd, ".env.local"), "utf8");

  expect(result.exitCode).toBe(0);
  expect(envLocal).toContain('BROODS_STAGE="staging"');
  expect(envLocal).toContain('BROODS_API_KEY="fp_old_key"');
  expect(result.stdout).toContain("Could not read the runtime key");
});

test("stage use creates .env.local when the project has none", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "broods-stage-use-bare-"));
  workdirs.push(cwd);
  const baseUrl = serveBackend(() =>
    Response.json({ apiKey: "fp_new_key", keyHint: "fp_…_key" }),
  );

  const result = await runStageUse(cwd, baseUrl);
  const envLocal = await readFile(join(cwd, ".env.local"), "utf8");

  expect(result.exitCode).toBe(0);
  expect(envLocal).toContain('BROODS_STAGE="staging"');
  expect(envLocal).toContain('BROODS_API_KEY="fp_new_key"');
});

test("stage use appends BROODS_API_KEY when .env.local has no such line", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "broods-stage-use-nokey-"));
  workdirs.push(cwd);
  await writeFile(
    join(cwd, ".env.local"),
    ['BROODS_PROJECT="demo-app"', 'OPENAI_API_KEY="sk-keep-me"', ""].join("\n"),
    "utf8",
  );
  const baseUrl = serveBackend(() =>
    Response.json({ apiKey: "fp_new_key", keyHint: "fp_…_key" }),
  );

  const result = await runStageUse(cwd, baseUrl);
  const envLocal = await readFile(join(cwd, ".env.local"), "utf8");

  expect(result.exitCode).toBe(0);
  expect(envLocal).toContain('BROODS_API_KEY="fp_new_key"');
  // Unrelated lines must survive the upsert.
  expect(envLocal).toContain('OPENAI_API_KEY="sk-keep-me"');
});

// A shell export beats `.env.local` on every later command, so rewriting the
// file alone would leave `broods run`/`logs` on the abandoned stage's key.
test("stage use warns when a shell export shadows the rewritten key", async () => {
  const cwd = await projectDir();
  const baseUrl = serveBackend(() =>
    Response.json({ apiKey: "fp_new_key", keyHint: "fp_…_key" }),
  );

  const result = await runStageUse(cwd, baseUrl, {
    BROODS_API_KEY: "fp_exported_key",
    BROODS_STAGE: "production",
  });
  const envLocal = await readFile(join(cwd, ".env.local"), "utf8");

  expect(result.exitCode).toBe(0);
  expect(envLocal).toContain('BROODS_API_KEY="fp_new_key"');
  expect(result.stdout).toContain("BROODS_API_KEY is exported in your shell");
  expect(result.stdout).toContain("BROODS_STAGE is exported in your shell");
});
