import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * `broods run` reaches the agent with the developer's stage ticket, the
 * credential `logs` uses, not the runtime key: it runs private agents and
 * agents that require a user token. A ticket lasts 15 minutes, so one with
 * under a minute left is re-minted before the request. Without a login (a
 * project or account key) it keeps the runtime key.
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

/** A fake control plane and agent endpoint; tickets live `ticketTtlMs`. */
function serveBackend(
  ticketTtlMs: number,
  refuseTickets = false,
): {
  baseUrl: string;
  minted: string[];
  authorizations: Array<string | null>;
} {
  const minted: string[] = [];
  const authorizations: Array<string | null> = [];
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/v1/account/stage-session") {
        // What the route answers a project or account key.
        if (refuseTickets) {
          return new Response("Stage sessions require a `broods login` token", {
            status: 401,
          });
        }
        const token = `ticket-${minted.length + 1}`;
        minted.push(token);

        return Response.json({
          token: token,
          expiresAt: Date.now() + ticketTtlMs,
          projectSlug: "demo-app",
          stageSlug: "development",
        });
      }
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
        });
      }
      if (request.method === "POST") {
        authorizations.push(request.headers.get("authorization"));

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

  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    minted: minted,
    authorizations: authorizations,
  };
}

async function runAgent(
  baseUrl: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const cwd = await mkdtemp(join(tmpdir(), "broods-run-ticket-"));
  workdirs.push(cwd);
  await mkdir(join(cwd, "broods"), { recursive: true });
  // A private agent: no publicAccess, which the runtime key would need.
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
    'BROODS_PROJECT="demo-app"\nBROODS_STAGE="x"\n',
  );
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
    },
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  return { exitCode: exitCode, stdout: stdout, stderr: stderr };
}

test("run sends the stage ticket, not the runtime key", async () => {
  const backend = serveBackend(15 * 60_000);

  const result = await runAgent(backend.baseUrl);

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("pong");
  expect(backend.authorizations).toEqual(["Bearer ticket-1"]);
});

test("run re-mints a ticket with under a minute left", async () => {
  const backend = serveBackend(30_000);

  const result = await runAgent(backend.baseUrl);

  expect(result.exitCode).toBe(0);
  expect(backend.authorizations).toEqual(["Bearer ticket-2"]);
});

test("run without a login keeps the runtime key and says what it reaches", async () => {
  const backend = serveBackend(15 * 60_000, true);

  const result = await runAgent(backend.baseUrl);

  expect(result.exitCode).toBe(0);
  expect(backend.authorizations).toEqual(["Bearer bsk_runtime-key-test"]);
  expect(result.stdout + result.stderr).toContain("No broods login");
});
