import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * `broods deploy` sends Production's region, from `--region` or BROODS_REGION
 * in .env.local, so an automated deploy chooses where Production runs. Other
 * stages send none, and `--region` on one is refused before any request.
 */

const CLI = new URL("../src/cli/index.ts", import.meta.url).pathname;
const RESOURCES_MODULE = join(import.meta.dir, "..", "src", "resources.ts");

const servers: Array<{ stop: () => void }> = [];
const workdirs: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop();
  for (const dir of workdirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

/** A fake control plane that records each manifest PUT's region. */
function serveBackend(): { baseUrl: string; regions: unknown[] } {
  const regions: unknown[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      if (!new URL(request.url).pathname.endsWith("/manifest")) {
        return new Response("not found", { status: 404 });
      }
      const body = (await request.json()) as {
        manifest: { stage: string; region?: string };
      };
      regions.push(body.manifest.region);

      return Response.json({
        manifest: { ...body.manifest, resources: [] },
        ids: {
          agents: {},
          workspaces: {},
          sandboxes: {},
          crons: {},
          skills: {},
          hooks: {},
          mcp: {},
        },
      });
    },
  });
  servers.push(server);

  return { baseUrl: `http://127.0.0.1:${server.port}`, regions: regions };
}

async function deploy(
  args: string[],
  envLocal: string[],
  baseUrl: string,
): Promise<{ exitCode: number; output: string }> {
  const cwd = await mkdtemp(join(tmpdir(), "broods-deploy-region-"));
  workdirs.push(cwd);
  await mkdir(join(cwd, "broods"), { recursive: true });
  await writeFile(
    join(cwd, "broods", "agents.ts"),
    `
import { defineAgent } from "${RESOURCES_MODULE}";

export const support = defineAgent({
  name: "support",
  model: { provider: "openai", modelId: "gpt-5-mini" },
});
`,
  );
  await writeFile(
    join(cwd, ".env.local"),
    ['BROODS_PROJECT="demo-app"', ...envLocal, ""].join("\n"),
  );
  const proc = Bun.spawn({
    cmd: [process.execPath, CLI, "deploy", ...args],
    cwd: cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      BROODS_TOKEN: "tok",
      BROODS_BASE_URL: baseUrl,
    },
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  return { exitCode: exitCode, output: stdout + stderr };
}

test("--region rides the production manifest, over BROODS_REGION", async () => {
  const backend = serveBackend();

  const result = await deploy(
    ["--region", "eu-west-1"],
    ['BROODS_REGION="us-east-1"'],
    backend.baseUrl,
  );

  expect(result.exitCode).toBe(0);
  expect(backend.regions).toEqual(["eu-west-1"]);
});

test("BROODS_REGION from .env.local is Production's region without the flag", async () => {
  const backend = serveBackend();

  await deploy([], ['BROODS_REGION="eu-west-1"'], backend.baseUrl);

  expect(backend.regions).toEqual(["eu-west-1"]);
});

test("a deploy to another stage sends no region, and refuses --region", async () => {
  const backend = serveBackend();

  await deploy(
    ["--stage", "staging"],
    ['BROODS_REGION="eu-west-1"'],
    backend.baseUrl,
  );
  const refused = await deploy(
    ["--stage", "staging", "--region", "eu-west-1"],
    [],
    backend.baseUrl,
  );

  expect(backend.regions).toEqual([undefined]);
  expect(refused.exitCode).not.toBe(0);
  expect(refused.output).toContain(
    "--region applies only to the production stage",
  );
});

test("an unknown region is refused before any request", async () => {
  const backend = serveBackend();

  const result = await deploy(["--region", "mars-1"], [], backend.baseUrl);

  expect(result.exitCode).not.toBe(0);
  expect(result.output).toContain("Unknown region mars-1");
  expect(backend.regions).toEqual([]);
});
