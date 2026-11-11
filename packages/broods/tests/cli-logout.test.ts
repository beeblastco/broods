import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const CLI = new URL("../src/cli/index.ts", import.meta.url).pathname;
const OTHER_SERVER = "https://gateway.other.example";

const servers: Array<{ stop: () => void }> = [];
const workdirs: string[] = [];

afterEach(async (): Promise<void> => {
  for (const server of servers.splice(0)) server.stop();
  for (const dir of workdirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

test("logout revokes the login on its server and keeps other servers' logins", async (): Promise<void> => {
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: (request): Response => {
      requests.push(
        `${request.method} ${new URL(request.url).pathname} ${request.headers.get("authorization")}`,
      );

      return new Response(null, { status: 204 });
    },
  });
  servers.push(server);
  const baseUrl = `http://127.0.0.1:${server.port}`;
  const home = await mkdtemp(join(tmpdir(), "broods-home-"));
  workdirs.push(home);
  await mkdir(join(home, ".broods"));
  const configPath = join(home, ".broods", "config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      current: baseUrl,
      logins: {
        [OTHER_SERVER]: login(OTHER_SERVER, "bcli_other"),
        [baseUrl]: login(baseUrl, "bcli_mine"),
      },
    }),
    "utf8",
  );

  const proc = Bun.spawn({
    cmd: [process.execPath, CLI, "logout"],
    cwd: home,
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: process.env.PATH ?? "", HOME: home },
  });

  expect(await proc.exited).toBe(0);
  expect(requests).toEqual(["DELETE /v1/account/auth/token Bearer bcli_mine"]);
  const config = JSON.parse(await readFile(configPath, "utf8")) as {
    current: string;
    logins: Record<string, unknown>;
  };
  expect(config.current).toBe(OTHER_SERVER);
  expect(Object.keys(config.logins)).toEqual([OTHER_SERVER]);
});

test("logout with BROODS_TOKEN set revokes only the saved login it removes and says the env token stays", async (): Promise<void> => {
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: (request): Response => {
      requests.push(request.headers.get("authorization") ?? "");

      return new Response(null, { status: 204 });
    },
  });
  servers.push(server);
  const baseUrl = `http://127.0.0.1:${server.port}`;
  const home = await mkdtemp(join(tmpdir(), "broods-home-"));
  workdirs.push(home);
  await mkdir(join(home, ".broods"));
  const configPath = join(home, ".broods", "config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      current: baseUrl,
      logins: { [baseUrl]: login(baseUrl, "bcli_mine") },
    }),
    "utf8",
  );

  const proc = Bun.spawn({
    cmd: [process.execPath, CLI, "logout"],
    cwd: home,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      BROODS_TOKEN: "bcli_ci",
      BROODS_BASE_URL: baseUrl,
    },
  });

  expect(await proc.exited).toBe(0);
  expect(requests).toEqual(["Bearer bcli_mine"]);
  const output = `${await new Response(proc.stdout).text()}${await new Response(proc.stderr).text()}`;
  expect(output).toContain("BROODS_TOKEN is set");
  const config = JSON.parse(await readFile(configPath, "utf8")) as {
    logins: Record<string, unknown>;
  };
  expect(config.logins).toEqual({});
});

function login(
  baseUrl: string,
  token: string,
): { baseUrl: string; token: string; createdAt: string } {
  return { baseUrl: baseUrl, token: token, createdAt: "2026-01-01T00:00:00Z" };
}
