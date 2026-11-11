import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { handleApplyRunRequest } from "../../../../apps/core/src/harness/apply-runs.ts";
import * as planLimits from "../../../../apps/core/src/harness/plan-limits.ts";
import * as platformWorker from "../../../../apps/core/src/harness/sandbox/platform-worker.ts";
import { coreRequest } from "../../../../apps/core/tests/helpers/http.ts";

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_ENV = { ...process.env };
const scripts: string[] = [];

interface SandboxBody {
  argv: string[];
}

beforeAll((): void => {
  spyOn(planLimits, "recordUsage").mockImplementation((): void => {});
  spyOn(platformWorker, "reservePlatformSandbox").mockResolvedValue("apply-1");
  process.env.SERVICE_AUTH_SECRET = "service";
  process.env.PUBLIC_BASE_URL = "https://broods.test";
  process.env.APPLY_SANDBOX = JSON.stringify({ provider: "cloudflare" });
  process.env.CLOUDFLARE_SANDBOX_URL = "http://127.0.0.1:9";
  process.env.CLOUDFLARE_SANDBOX_API_KEY = "key";
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as SandboxBody;
    scripts.push(body.argv.at(-1) ?? "");

    return Response.json({
      ok: true,
      exit_code: 0,
      timed_out: false,
      truncated: false,
      stdout: "",
      stderr: "",
      duration_ms: 1,
    });
  }) as typeof fetch;
});

afterAll((): void => {
  globalThis.fetch = ORIGINAL_FETCH;
  process.env = ORIGINAL_ENV;
});

test("every approved file becomes one write command, quoted for the shell", async () => {
  scripts.length = 0;
  const files = Array.from({ length: 10 }, (_, index) => ({
    path: `broods/agents/agent-${index}.ts`,
    content: `export const name = "it's ${index}";\n`,
  }));

  const response = await apply([
    ...files,
    { path: "/package.json", content: "{}" },
  ]);

  expect(response.status).toBe(200);
  expect(scripts).toHaveLength(1);
  for (const file of files) {
    const written = `printf '%s' '${Buffer.from(file.content).toString("base64")}' | base64 -d > './${file.path}'`;
    expect(scripts[0]).toContain(written);
  }
  expect(scripts[0]).toContain("> './package.json'");
  expect(scripts[0]).toContain(
    `mkdir -p "$(dirname './broods/agents/agent-0.ts')"`,
  );
});

test("a path that climbs out of the workspace is refused before anything runs", async () => {
  scripts.length = 0;

  await expect(
    apply([{ path: "../outside.ts", content: "export {};\n" }]),
  ).rejects.toThrow("Invalid path: directory traversal not allowed");

  expect(scripts).toEqual([]);
});

async function apply(
  files: Array<{ path: string; content: string }>,
): Promise<Response> {
  return await handleApplyRunRequest(
    coreRequest(
      "POST",
      "/v1/apply-runs",
      { Authorization: "Bearer service" },
      {
        accountId: "acct_1",
        projectId: "p1",
        stageId: "s1",
        project: "dock",
        stage: "development",
        ticket: "bdap_t",
        lockHash: "lock",
        files: files,
      },
    ),
  );
}
