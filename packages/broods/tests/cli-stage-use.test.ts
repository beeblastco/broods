import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
    // Minimal env: the runner's own BROODS_* vars would shadow `.env.local`.
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
  expect(envLocal).toContain('OPENAI_API_KEY="sk-keep-me"');
});

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
