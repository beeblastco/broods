import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CliOnboardingContext } from "../src/sync";

/**
 * `whoami` must not present a folder name as the project in effect. Before a
 * project is chosen there is no remote scope, so it must not query one either.
 */

const CLI = new URL("../src/cli/index.ts", import.meta.url).pathname;

const ONBOARDING: CliOnboardingContext = {
  currentOrgId: "org_1",
  orgs: [],
  projects: [],
};

const servers: Array<{ stop: () => void }> = [];
const workdirs: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop();
  for (const dir of workdirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

test("reports no project when only the folder name is known", async () => {
  const { baseUrl, paths } = serveBackend();
  const cwd = await workdir([]);

  const result = await runWhoami(cwd, baseUrl);

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toMatch(
    /Project: +none \(broods-whoami-\w+ from folder name\)/,
  );
  expect(result.stdout).toContain("No project set.");
  expect(paths.some((path) => path.endsWith("/runtime-key"))).toBe(false);
});

test("checks the runtime key once a project is set", async () => {
  const { baseUrl, paths } = serveBackend();
  const cwd = await workdir(['BROODS_PROJECT="demo-app"']);

  const result = await runWhoami(cwd, baseUrl);

  expect(result.stdout).toMatch(/Project: +demo-app\n/);
  expect(result.stdout).not.toContain("No project set.");
  expect(paths.some((path) => path.endsWith("/runtime-key"))).toBe(true);
});

test("uses the login for the server .env.local names, not the latest one", async () => {
  const dev = serveBackend();
  const prod = serveBackend();
  const home = await homeWithLogins([dev.baseUrl, prod.baseUrl]);
  const cwd = await workdir([`BROODS_BASE_URL="${dev.baseUrl}"`]);

  const result = await runWhoami(cwd, undefined, home);

  expect(result.stdout).toContain(`Server:      ${dev.baseUrl}\n`);
  expect(prod.paths).toEqual([]);
});

test("refuses another server's login when .env.local names one without a login", async () => {
  const prod = serveBackend();
  const home = await homeWithLogins([prod.baseUrl]);
  const cwd = await workdir(['BROODS_BASE_URL="https://gateway.dev.example"']);

  const result = await runWhoami(cwd, undefined, home);

  expect(result.stdout).toContain(
    "Not logged in to https://gateway.dev.example.",
  );
  expect(prod.paths).toEqual([]);
});

/**
 * Runs `whoami` with a minimal env. With `baseUrl` it authenticates through
 * BROODS_TOKEN; without it, through the login file under `home`.
 */
async function runWhoami(
  cwd: string,
  baseUrl?: string,
  home?: string,
): Promise<{ exitCode: number; stdout: string }> {
  const proc = Bun.spawn({
    cmd: [process.execPath, CLI, "whoami"],
    cwd: cwd,
    stdout: "pipe",
    stderr: "ignore",
    // Minimal env: the runner's own BROODS_* vars would shadow `.env.local`.
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home ?? process.env.HOME ?? "",
      ...(baseUrl ? { BROODS_TOKEN: "tok", BROODS_BASE_URL: baseUrl } : {}),
    },
  });
  const [exitCode, stdout] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
  ]);

  return { exitCode: exitCode, stdout: stdout };
}

/** A HOME whose login file holds one login per server; the last is the most recent. */
async function homeWithLogins(baseUrls: string[]): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "broods-home-"));
  workdirs.push(home);
  await mkdir(join(home, ".broods"));
  const logins = Object.fromEntries(
    baseUrls.map((baseUrl) => [
      baseUrl,
      { baseUrl: baseUrl, token: "tok", createdAt: "2026-01-01T00:00:00Z" },
    ]),
  );
  await writeFile(
    join(home, ".broods", "config.json"),
    JSON.stringify({ current: baseUrls.at(-1), logins: logins }),
    "utf8",
  );

  return home;
}

/** A fake control plane that records every path `whoami` requests. */
function serveBackend(): { baseUrl: string; paths: string[] } {
  const paths: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const url = new URL(request.url);
      paths.push(url.pathname);
      if (url.pathname === "/v1/account/onboarding") {
        return Response.json(ONBOARDING);
      }

      return new Response("not found", { status: 404 });
    },
  });
  servers.push(server);

  return { baseUrl: `http://127.0.0.1:${server.port}`, paths: paths };
}

async function workdir(envLocal: string[]): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "broods-whoami-"));
  workdirs.push(cwd);
  if (envLocal.length > 0) {
    await writeFile(
      join(cwd, ".env.local"),
      `${envLocal.join("\n")}\n`,
      "utf8",
    );
  }

  return cwd;
}
