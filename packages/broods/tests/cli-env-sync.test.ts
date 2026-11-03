import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = new URL("../src/cli/index.ts", import.meta.url).pathname;
const RESOURCES_MODULE = join(import.meta.dir, "..", "src", "resources.ts");

const LOCAL_VALUES = {
  IN_STEP_KEY: "same-on-both-sides",
  DRIFTED_KEY: "rotated-locally",
  UNSET_KEY: "never-pushed",
};

const servers: Array<{ stop: () => void }> = [];
const workdirs: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop();
  for (const dir of workdirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

test("env sync pushes the drifted and unset vars and leaves the matching one", async () => {
  const cwd = await projectDir();
  const { baseUrl, puts } = serveBackend();

  const result = await runCli(cwd, baseUrl, ["env", "sync"]);
  const output = `${result.stdout}${result.stderr}`;

  expect(result.exitCode).toBe(0);
  expect(puts.sort()).toEqual(["DRIFTED_KEY", "UNSET_KEY"]);
  expect(output).toContain("DRIFTED_KEY");
  expect(output).toContain("UNSET_KEY");
  expect(output).toContain(
    "1 other referenced variable(s) already in step with demo-app/development",
  );
});

test("env sync names the referenced vars .env.local does not control", async () => {
  const cwd = await projectDir();
  const { baseUrl, puts } = serveBackend();

  const result = await runCli(cwd, baseUrl, ["env", "sync"]);
  const output = `${result.stdout}${result.stderr}`;

  expect(result.exitCode).toBe(0);
  expect(output).toContain(
    "1 referenced variable(s) live only on demo-app/development: STAGE_ONLY_KEY",
  );
  expect(puts).not.toContain("STAGE_ONLY_KEY");
  expect(output).not.toContain("UNREFERENCED_KEY");
});

test("env sync names the refs with no value on either side", async () => {
  const cwd = await projectDir();
  const { baseUrl } = serveBackend();

  const result = await runCli(cwd, baseUrl, ["env", "sync"]);

  expect(result.exitCode).toBe(0);
  expect(`${result.stdout}${result.stderr}`).toContain(
    "no value here or on demo-app/development: NOWHERE_KEY",
  );
});

test("diff warns about a stage value that no longer matches .env.local", async () => {
  const cwd = await projectDir();
  const { baseUrl, puts } = serveBackend();

  const result = await runCli(cwd, baseUrl, ["diff"]);
  const output = `${result.stdout}${result.stderr}`;

  expect(result.exitCode).toBe(0);
  expect(output).toContain("disagree on 1 variable(s): DRIFTED_KEY");
  expect(output).toContain("broods env sync");
  expect(puts).toEqual([]);
});

function serveBackend(): {
  baseUrl: string;
  puts: string[];
} {
  const puts: string[] = [];
  const variables = [
    {
      name: "IN_STEP_KEY",
      updatedAt: 1,
      valueDigest: sha256Hex(LOCAL_VALUES.IN_STEP_KEY),
    },
    {
      name: "DRIFTED_KEY",
      updatedAt: 2,
      valueDigest: sha256Hex("what-the-stage-still-holds"),
    },
    { name: "STAGE_ONLY_KEY", updatedAt: 3, valueDigest: sha256Hex("secret") },
    {
      name: "UNREFERENCED_KEY",
      updatedAt: 4,
      valueDigest: sha256Hex("left-alone"),
    },
  ];
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/env") && request.method === "GET") {
        return Response.json({ variables: variables });
      }
      if (url.pathname.includes("/env/") && request.method === "PUT") {
        puts.push(url.pathname.split("/env/")[1]!);

        return Response.json({ ok: true });
      }
      if (url.pathname.endsWith("/manifest")) {
        return new Response("", { status: 404 });
      }

      return new Response("not found", { status: 404 });
    },
  });
  servers.push(server);

  return { baseUrl: `http://127.0.0.1:${server.port}`, puts: puts };
}

// One `env()` ref per drift state: in step, drifted, stage-only, local-only, on neither.
async function projectDir(): Promise<string> {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "broods-env-sync-")));
  workdirs.push(cwd);
  await writeFile(
    join(cwd, ".env.local"),
    [
      'BROODS_PROJECT="demo-app"',
      'BROODS_STAGE="development"',
      ...Object.entries(LOCAL_VALUES).map(
        ([name, value]) => `${name}="${value}"`,
      ),
      "",
    ].join("\n"),
    "utf8",
  );

  const pkgDir = join(cwd, "node_modules", "broods");
  await mkdir(pkgDir, { recursive: true });
  await writeFile(
    join(pkgDir, "package.json"),
    JSON.stringify({ name: "broods", type: "module", main: "index.mjs" }),
  );
  await writeFile(
    join(pkgDir, "index.mjs"),
    `export * from ${JSON.stringify(RESOURCES_MODULE)};\n`,
  );

  const projectDirPath = join(cwd, "broods");
  await mkdir(projectDirPath, { recursive: true });
  await writeFile(
    join(projectDirPath, "agents.ts"),
    `import { defineAgent, defineBroods, env } from "broods";\n` +
      `export default defineBroods({ project: "demo-app" });\n` +
      `export const myAgent = defineAgent({\n` +
      `  name: "my-agent",\n` +
      `  provider: {\n` +
      `    openai: {\n` +
      `      apiKey: env("IN_STEP_KEY"),\n` +
      `      baseURL: env("DRIFTED_KEY"),\n` +
      `      organization: env("UNSET_KEY"),\n` +
      `      project: env("NOWHERE_KEY"),\n` +
      `    },\n` +
      `    anthropic: { apiKey: env("STAGE_ONLY_KEY") },\n` +
      `  },\n` +
      `  model: { provider: "openai", modelId: "gpt-5-mini" },\n` +
      `});\n`,
  );

  return cwd;
}

async function runCli(
  cwd: string,
  baseUrl: string,
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn({
    cmd: [process.execPath, CLI, ...args],
    cwd: cwd,
    stdout: "pipe",
    stderr: "pipe",
    // Minimal env: the runner's own BROODS_* vars would shadow `.env.local`.
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      BROODS_TOKEN: "tok",
      BROODS_BASE_URL: baseUrl,
      NO_COLOR: "1",
    },
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  return { exitCode: exitCode, stdout: stdout, stderr: stderr };
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
