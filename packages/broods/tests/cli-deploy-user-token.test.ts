import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * `broods deploy` writes the stage's user-token signing secret next to the
 * runtime key: a new agent refuses the bare runtime key, so a checkout without
 * the secret could not sign a token. It rotates the secret only when the
 * stage has none or this checkout lacks a non-production stage's, and never
 * prints it.
 */

const CLI = new URL("../src/cli/index.ts", import.meta.url).pathname;
const RESOURCES_MODULE = join(import.meta.dir, "..", "src", "resources.ts");
const SECRET = "bsig_minted-for-this-test-wxyz";

const servers: Array<{ stop: () => void }> = [];
const workdirs: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop();
  for (const dir of workdirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

type Stage = {
  stageKind: "development" | "production";
  userTokenSecretHint?: string;
};

/** A fake control plane for the manifest PUT and the secret rotation. */
function serveBackend(stage: Stage): { baseUrl: string; rotations: string[] } {
  const rotations: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/manifest") && request.method === "PUT") {
        return Response.json({
          manifest: {
            version: 1,
            project: "demo-app",
            stage: "x",
            resources: [],
          },
          ids: {
            agents: { support: "agent_1" },
            workspaces: {},
            sandboxes: {},
            crons: {},
            skills: {},
            hooks: {},
            mcp: {},
          },
          deployment: {
            accountId: "acct_1",
            endpointId: "stage-1",
            projectSlug: "demo-app",
            stageSlug: "production",
            keyHint: "bsk_…test",
            apiKey: "bsk_runtime-key-test",
            ...stage,
          },
        });
      }
      if (url.pathname.endsWith("/user-token-secret")) {
        rotations.push(request.method);

        return Response.json({ secret: SECRET, hint: "bsig_…wxyz" });
      }

      return new Response("not found", { status: 404 });
    },
  });
  servers.push(server);

  return { baseUrl: `http://127.0.0.1:${server.port}`, rotations: rotations };
}

async function projectDir(envLocal: string[] = []): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "broods-deploy-secret-"));
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

  return cwd;
}

async function runDeploy(
  cwd: string,
  baseUrl: string,
): Promise<{ exitCode: number; output: string; envLocal: string }> {
  const proc = Bun.spawn({
    cmd: [process.execPath, CLI, "deploy"],
    cwd: cwd,
    stdout: "pipe",
    stderr: "pipe",
    // Minimal env, so the runner's own BROODS_* vars cannot shadow .env.local.
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

  return {
    exitCode: exitCode,
    output: stdout + stderr,
    envLocal: await readFile(join(cwd, ".env.local"), "utf8"),
  };
}

test("deploy mints the first signing secret into .env.local without printing it", async () => {
  const cwd = await projectDir();
  const backend = serveBackend({ stageKind: "production" });

  const result = await runDeploy(cwd, backend.baseUrl);

  expect(result.exitCode).toBe(0);
  expect(backend.rotations).toEqual(["POST"]);
  expect(result.envLocal).toContain(`BROODS_USER_TOKEN_SECRET="${SECRET}"`);
  expect(result.output).toContain("Wrote a new user token signing secret");
  expect(result.output).not.toContain(SECRET);
});

test("deploy keeps a production stage's existing secret when this checkout lacks it", async () => {
  const cwd = await projectDir();
  const backend = serveBackend({
    stageKind: "production",
    userTokenSecretHint: "bsig_…abcd",
  });

  const result = await runDeploy(cwd, backend.baseUrl);

  expect(result.exitCode).toBe(0);
  expect(backend.rotations).toEqual([]);
  expect(result.envLocal).not.toContain("BROODS_USER_TOKEN_SECRET");
  expect(result.output).toContain("already has a user token signing secret");
});

test("deploy keeps a development stage's secret this checkout does not hold", async () => {
  const cwd = await projectDir([
    'BROODS_STAGE="development"',
    'BROODS_USER_TOKEN_SECRET="bsig_someone-elses-1234"',
  ]);
  const backend = serveBackend({
    stageKind: "development",
    userTokenSecretHint: "bsig_…abcd",
  });

  const result = await runDeploy(cwd, backend.baseUrl);

  expect(result.exitCode).toBe(0);
  expect(backend.rotations).toEqual([]);
  expect(result.envLocal).toContain("someone-elses");
  expect(result.output).toContain("already has a user token signing secret");
});

test("deploy leaves a secret that matches the stage alone", async () => {
  const cwd = await projectDir([`BROODS_USER_TOKEN_SECRET="${SECRET}"`]);
  const backend = serveBackend({
    stageKind: "development",
    userTokenSecretHint: "bsig_…wxyz",
  });

  const result = await runDeploy(cwd, backend.baseUrl);

  expect(result.exitCode).toBe(0);
  expect(backend.rotations).toEqual([]);
  expect(result.output).not.toContain("user token signing secret");
});

test("deploy still succeeds when the rotation is refused", async () => {
  const cwd = await projectDir();
  const server = Bun.serve({
    port: 0,
    fetch: (request) =>
      new URL(request.url).pathname.endsWith("/user-token-secret")
        ? Response.json(
            { error: { message: "needs keys:write", code: "forbidden" } },
            { status: 403 },
          )
        : Response.json({
            manifest: {
              version: 1,
              project: "demo-app",
              stage: "x",
              resources: [],
            },
            ids: {
              agents: {},
              workspaces: {},
              sandboxes: {},
              crons: {},
              skills: {},
              hooks: {},
              mcp: {},
            },
            deployment: {
              accountId: "acct_1",
              endpointId: "stage-1",
              projectSlug: "demo-app",
              stageSlug: "production",
              stageKind: "production",
              keyHint: "bsk_…test",
              apiKey: "bsk_runtime-key-test",
            },
          }),
  });
  servers.push(server);

  const result = await runDeploy(cwd, `http://127.0.0.1:${server.port}`);

  expect(result.exitCode).toBe(0);
  expect(result.output).toContain("needs keys:write");
  expect(result.envLocal).not.toContain("BROODS_USER_TOKEN_SECRET");
});
