import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { handleApplyRunRequest } from "../src/harness/apply-runs.ts";
import * as planLimits from "../src/harness/plan-limits.ts";
import { coreRequest } from "./helpers/http.ts";

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_ENV = { ...process.env };
const sent: { script: string; env: Record<string, string>; id: string }[] = [];
const RUN = {
  accountId: "acct_1",
  projectId: "p1",
  stageId: "s1",
  project: "dock",
  stage: "development",
  ticket: "bdap_t",
  lockHash: "lock",
  files: [{ path: "broods/index.ts", content: "export {};\n" }],
};

beforeAll((): void => {
  spyOn(planLimits, "recordUsage").mockImplementation((): void => {});
  process.env.SERVICE_AUTH_SECRET = "service";
  process.env.PUBLIC_BASE_URL = "https://broods.test";
  process.env.CLOUDFLARE_WORKER_URL = "http://127.0.0.1:9";
  process.env.CLOUDFLARE_WORKER_API_KEY = "key";
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as {
      script: string;
      env: Record<string, string>;
    };
    sent.push({ ...body, id: String(url) });

    return Response.json({
      ok: true,
      exit_code: 0,
      timed_out: false,
      truncated: false,
      stdout: "::phase install 40\nSynced 1 resources\n::phase deploy 900\n",
      stderr: "",
      duration_ms: 1,
    });
  }) as typeof fetch;
});

afterAll((): void => {
  globalThis.fetch = ORIGINAL_FETCH;
  process.env = ORIGINAL_ENV;
});

const call = (headers: Record<string, string>) =>
  handleApplyRunRequest(coreRequest("POST", "/v1/apply-runs", headers, RUN));

describe("apply runs", () => {
  it("runs only for the in-cluster service token and a configured sandbox", async () => {
    delete process.env.APPLY_SANDBOX;

    expect((await call({ Authorization: "Bearer nope" })).status).toBe(401);
    expect((await call({ Authorization: "Bearer service" })).status).toBe(503);
  });

  it("deploys the files with the ticket in the sandbox's env and answers each phase", async () => {
    process.env.APPLY_SANDBOX = JSON.stringify({ provider: "worker" });

    const response = await call({ Authorization: "Bearer service" });

    expect(await response.json()).toMatchObject({
      ok: true,
      phases: { install: 40, deploy: 900 },
      output: "Synced 1 resources",
    });
    expect(sent[0]?.env).toMatchObject({
      BROODS_TOKEN: "bdap_t",
      APPLY_BASE_URL: "https://broods.test",
      BROODS_STAGE: "development",
    });
    expect(sent[0]?.script).toContain("bunx broods deploy");
    expect(sent[0]?.script).toContain("> './broods/index.ts'");
  });
});
