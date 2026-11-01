import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { keyHint } from "../../convex/model/accountSecrets.ts";
import {
  openUserToken,
  USER_TOKEN_HEADER,
} from "../../convex/model/userToken.ts";

/**
 * A new agent refuses the bare runtime key, so `broods run` signs each request
 * with the stage's signing secret from this checkout, as a backend would. With
 * no matching secret it sends none and names the fix when core refuses.
 */

const CLI = new URL("../src/cli/index.ts", import.meta.url).pathname;
const RESOURCES_MODULE = join(import.meta.dir, "..", "src", "resources.ts");
const SECRET = "bsig_signing-secret-for-run-test";

const servers: Array<{ stop: () => void }> = [];
const workdirs: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop();
  for (const dir of workdirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

/** A fake control plane plus the agent's SSE endpoint. */
function serveBackend(
  requireToken: boolean,
  sendHint = true,
): {
  baseUrl: string;
  tokens: Array<string | null>;
} {
  const tokens: Array<string | null> = [];
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const url = new URL(request.url);
      // The real GET /manifest carries no deployment; the hint rides /runtime-key.
      if (url.pathname.endsWith("/manifest")) {
        return Response.json({
          manifest: {
            version: 1,
            project: "demo-app",
            stage: "x",
            resources: [],
          },
          ids: { agents: { support: "agent_1" } },
          revision: 1,
        });
      }
      if (url.pathname.endsWith("/runtime-key")) {
        return Response.json({
          apiKey: "bsk_runtime-key-test",
          keyHint: "bsk_…test",
          ...(sendHint
            ? { userTokenSecretHint: keyHint("bsig_", SECRET) }
            : {}),
        });
      }
      if (request.method === "POST") {
        const token = request.headers.get(USER_TOKEN_HEADER);
        tokens.push(token);
        if (requireToken && !token) {
          return Response.json(
            {
              error: {
                message: "needs a user token",
                code: "user_token_required",
              },
            },
            { status: 403 },
          );
        }

        return new Response(
          [
            { type: "text-start", id: "0" },
            { type: "text-delta", id: "0", text: "pong" },
            { type: "text-end", id: "0" },
            { type: "finish", finishReason: "stop" },
          ]
            .map((part) => `data: ${JSON.stringify(part)}\n\n`)
            .join(""),
          { headers: { "content-type": "text/event-stream" } },
        );
      }

      return new Response("not found", { status: 404 });
    },
  });
  servers.push(server);

  return { baseUrl: `http://127.0.0.1:${server.port}`, tokens: tokens };
}

async function projectDir(envLocal: string[]): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "broods-run-token-"));
  workdirs.push(cwd);
  await mkdir(join(cwd, "broods"), { recursive: true });
  await writeFile(
    join(cwd, "broods", "agents.ts"),
    `
import { defineAgent } from "${RESOURCES_MODULE}";

export const support = defineAgent({
  name: "support",
  model: { provider: "openai", modelId: "gpt-5-mini" },
  publicAccess: true,
});
`,
  );
  await writeFile(
    join(cwd, ".env.local"),
    ['BROODS_PROJECT="demo-app"', 'BROODS_STAGE="x"', ...envLocal, ""].join(
      "\n",
    ),
  );

  return cwd;
}

async function runAgent(
  cwd: string,
  baseUrl: string,
  shell: Record<string, string> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn({
    cmd: [process.execPath, CLI, "run", "support", "ping"],
    cwd: cwd,
    stdout: "pipe",
    stderr: "pipe",
    // Minimal env, so the runner's own BROODS_* vars cannot shadow .env.local.
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      BROODS_TOKEN: "tok",
      BROODS_BASE_URL: baseUrl,
      ...shell,
    },
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  return { exitCode: exitCode, stdout: stdout, stderr: stderr };
}

test("run signs a user token with the checkout's signing secret", async () => {
  const cwd = await projectDir([`BROODS_USER_TOKEN_SECRET="${SECRET}"`]);
  const backend = serveBackend(true);

  const result = await runAgent(cwd, backend.baseUrl);

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("pong");
  const token = backend.tokens[0];
  expect(token).toBeString();
  // No login email (env-token auth): a digest, so two tokens never share an id.
  expect((await openUserToken(token ?? "", SECRET))?.userId).toMatch(
    /^cli-[0-9a-f]{32}$/,
  );
});

test("run without the stage's secret sends no token and names the fix", async () => {
  const cwd = await projectDir([
    'BROODS_USER_TOKEN_SECRET="bsig_some-other-stage"',
  ]);
  const backend = serveBackend(true);

  const result = await runAgent(cwd, backend.baseUrl);

  expect(result.exitCode).not.toBe(0);
  expect(backend.tokens).toEqual([null]);
  expect(result.stderr).toContain("requires a signed user token");
  expect(result.stderr).toContain("BROODS_USER_TOKEN_SECRET");
});

test("run sends no token for a stage without a signing secret", async () => {
  const cwd = await projectDir([`BROODS_USER_TOKEN_SECRET="${SECRET}"`]);
  const backend = serveBackend(false, false);

  const result = await runAgent(cwd, backend.baseUrl);

  // A stale local secret must not turn a run that needs no token into a 401.
  expect(result.exitCode).toBe(0);
  expect(backend.tokens).toEqual([null]);
});

test("a stale shell secret loses to the .env.local one the stage names", async () => {
  const cwd = await projectDir([`BROODS_USER_TOKEN_SECRET="${SECRET}"`]);
  const backend = serveBackend(true);

  const result = await runAgent(cwd, backend.baseUrl, {
    BROODS_USER_TOKEN_SECRET: "bsig_stale-shell-export",
  });

  expect(result.exitCode).toBe(0);
  expect(await openUserToken(backend.tokens[0] ?? "", SECRET)).not.toBeNull();
});
