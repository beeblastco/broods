/**
 * The isolate executor against a mocked Worker: what it sends, when it
 * reserves and reuses stored files, and which instance rows it mirrors. The
 * Worker itself is tested in its own workspace under Miniflare.
 */

import { afterEach, beforeEach, expect, it, mock, spyOn } from "bun:test";
import { MAX_TIMEOUT_MS } from "../../cloudflare-isolate/src/limits.ts";
import * as instanceStore from "../src/harness/sandbox/instance-store.ts";
import {
  IsolateSandboxExecutor,
  isolateConnection,
} from "../src/harness/sandbox/isolate-executor.ts";
import type { SandboxExecutorConfig } from "../src/harness/sandbox/types.ts";
import * as sandboxInstances from "../src/shared/convex/sandbox-instances.ts";
import { requestUrl } from "./helpers/http.ts";
import { ISOLATE_MAX_TIMEOUT_SECONDS } from "@broods/convex/model/sandboxRules";

// A successful Worker exec answer, in the shared exec contract's shape.
const EXEC_OK = {
  ok: true,
  exit_code: 0,
  timed_out: false,
  duration_ms: 5,
  stdout: "ok\n",
  stderr: "",
  truncated: false,
};
const config: SandboxExecutorConfig = {
  provider: "isolate",
  network: { mode: "deny-all" },
  envVars: { ACCOUNT_VAR: "a" },
  controlPlane: {
    accountId: "acct",
    name: "box",
    specs: { vcpu: 1, memoryMb: 128, storageGb: 0 },
  },
};
const request = {
  code: "true",
  reservationKey: "acct:workspace",
  timeoutSeconds: 10,
  outputLimitBytes: 1024,
};

interface WorkerCall {
  method: string;
  url: string;
  authorization: string | null;
  body: Record<string, unknown> | null;
}

const calls: WorkerCall[] = [];
const mirrored: string[] = [];
let stored: string | null = null;
let claimWins = true;

beforeEach((): void => {
  process.env.CLOUDFLARE_ISOLATE_URL = "https://isolate.example.com/";
  process.env.CLOUDFLARE_ISOLATE_API_KEY = "isolate-key";
  stored = null;
  claimWins = true;
  calls.length = 0;
  mirrored.length = 0;
  mockFetch(async (input, init): Promise<Response> => {
    const headers = new Headers(init?.headers);
    calls.push({
      method: init?.method ?? "GET",
      url: requestUrl(input),
      authorization: headers.get("Authorization"),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });
    if (requestUrl(input).endsWith("/exec")) return Response.json(EXEC_OK);
    if (init?.method === "GET") return Response.json({ exists: true });

    return new Response(null, { status: 204 });
  });
  spyOn(instanceStore, "getSandboxExternalId").mockImplementation(
    async (): Promise<string | null> => stored,
  );
  // A claim is a compare-and-swap: only the first one under a key wins.
  spyOn(instanceStore, "claimSandboxInstance").mockImplementation(
    async (_provider, _key, externalId): Promise<boolean> => {
      if (stored !== null) return false;
      stored = claimWins ? externalId : "winner-id";

      return claimWins;
    },
  );
  spyOn(instanceStore, "saveSandboxInstance").mockImplementation(
    async (): Promise<void> => {},
  );
  spyOn(instanceStore, "deleteSandboxInstance").mockImplementation(
    async (_provider, key): Promise<boolean> => {
      mirrored.push(`delete ${key}`);

      return true;
    },
  );
  spyOn(sandboxInstances, "upsertSandboxInstance").mockImplementation(
    async (_plane, _provider, key, _id, _meta, options): Promise<void> => {
      mirrored.push(`upsert ${key} ${options?.ephemeral === true}`);
    },
  );
});

afterEach((): void => {
  mock.restore();
  delete process.env.CLOUDFLARE_ISOLATE_URL;
  delete process.env.CLOUDFLARE_ISOLATE_API_KEY;
});

it("runs an ephemeral command on an empty disk and keeps no row for it", async (): Promise<void> => {
  const result = await new IsolateSandboxExecutor(config).run({
    code: "echo ok",
    timeoutSeconds: 10,
    outputLimitBytes: 1024,
    envVars: { PATH: "/evil", CALL_VAR: "b" },
    args: ["one"],
    principal: { accountId: "acct", agentId: "agent", runToken: "tok" },
  });
  await settled();

  expect(result).toMatchObject({
    ok: true,
    stdout: "ok\n",
    provider: "isolate",
  });
  expect(calls).toHaveLength(1);
  const [exec] = calls;
  expect(exec?.url).toMatch(
    /^https:\/\/isolate\.example\.com\/v1\/sandboxes\/fp-e-[0-9a-f-]+\/exec$/,
  );
  expect(exec?.authorization).toBe("Bearer isolate-key");
  expect(exec?.body).toEqual({
    script: "echo ok",
    args: ["one"],
    cwd: "/workspace",
    env: {
      ACCOUNT_VAR: "a",
      CALL_VAR: "b",
      BROODS_ACCOUNT_ID: "acct",
      BROODS_AGENT_ID: "agent",
      BROODS_RUN_TOKEN: "tok",
    },
    timeoutMs: 10_000,
    outputLimitBytes: 1024,
    enableInternet: false,
    persist: false,
  });
  expect(mirrored).toEqual([]);
});

it("clamps the timeout to the Worker's ceiling, the one the config plane enforces, and turns internet on from the network mode", async (): Promise<void> => {
  await new IsolateSandboxExecutor({
    ...config,
    network: { mode: "allow-all" },
  }).run({ code: "true", timeoutSeconds: 600, outputLimitBytes: 1024 });

  expect(calls[0]?.body).toMatchObject({
    timeoutMs: MAX_TIMEOUT_MS,
    enableInternet: true,
  });
  expect(ISOLATE_MAX_TIMEOUT_SECONDS * 1000).toBe(MAX_TIMEOUT_MS);
});

it("reserves one persistent sandbox, keeps its files across runs and mirrors it", async (): Promise<void> => {
  const executor = new IsolateSandboxExecutor({ ...config, persistent: true });
  await executor.run(request);
  await executor.run(request);
  await settled();

  expect(calls.map((call): string => call.method)).toEqual(["POST", "POST"]);
  expect(calls[0]?.url).toBe(calls[1]?.url);
  expect(calls[0]?.url).toContain(`/v1/sandboxes/${stored}/exec`);
  expect(calls[0]?.body).toMatchObject({ persist: true });
  expect(mirrored).toEqual([
    "upsert acct:workspace false",
    "upsert acct:workspace false",
  ]);
});

it("runs commands on one reservation one at a time, so none starts from stale files", async (): Promise<void> => {
  const inFlight: string[] = [];
  let peak = 0;
  mockFetch(async (input): Promise<Response> => {
    inFlight.push(requestUrl(input));
    peak = Math.max(peak, inFlight.length);
    await Bun.sleep(5);
    inFlight.pop();

    return Response.json(EXEC_OK);
  });
  const executor = new IsolateSandboxExecutor({ ...config, persistent: true });

  await Promise.all([executor.run(request), executor.run(request)]);

  expect(peak).toBe(1);
});

it("surfaces the Worker's refusal of a command that lost a race as a plain error", async (): Promise<void> => {
  mockFetch(
    async (): Promise<Response> =>
      new Response("another command changed the files", { status: 409 }),
  );

  const failure = await new IsolateSandboxExecutor({
    ...config,
    persistent: true,
  })
    .run(request)
    .then(
      (): string => "ran",
      (error: unknown): string => String(error),
    );
  await settled();

  expect(failure).toContain("failed (409): another command changed the files");
  expect(mirrored).toEqual([]);
});

it("takes the winner's id when it loses the reservation race", async (): Promise<void> => {
  claimWins = false;
  await new IsolateSandboxExecutor({ ...config, persistent: true }).run(
    request,
  );

  expect(calls[0]?.url).toContain("/v1/sandboxes/winner-id/exec");
});

it("runs a persistent config with no account and no reservation as ephemeral", async (): Promise<void> => {
  await new IsolateSandboxExecutor({
    ...config,
    persistent: true,
    controlPlane: undefined,
  }).run(request);

  expect(calls[0]?.url).toContain("/v1/sandboxes/fp-e-");
  expect(calls[0]?.body).toMatchObject({ persist: false });
});

it("reports stored files as a kept sandbox and drops them on release", async (): Promise<void> => {
  stored = "fp-p-existing";
  const executor = new IsolateSandboxExecutor({ ...config, persistent: true });

  expect(await executor.getInstanceInfo(request)).toEqual({
    externalId: "fp-p-existing",
    state: "suspended",
  });
  await executor.release(request);

  expect(calls.map((call): string => `${call.method} ${call.url}`)).toEqual([
    "GET https://isolate.example.com/v1/sandboxes/fp-p-existing",
    "DELETE https://isolate.example.com/v1/sandboxes/fp-p-existing",
  ]);
  expect(mirrored).toEqual(["delete acct:workspace"]);
});

it("refuses a workspace mount and a plain-HTTP Worker outside loopback", (): void => {
  expect(
    (): IsolateSandboxExecutor =>
      new IsolateSandboxExecutor({
        ...config,
        storage: { provider: "s3", bucket: "b" } as never,
      }),
  ).toThrow("cannot mount workspaces");
  process.env.CLOUDFLARE_ISOLATE_URL = "http://isolate.example.com";
  expect(isolateConnection).toThrow("must be https outside loopback");
  process.env.CLOUDFLARE_ISOLATE_URL = "http://127.0.0.1:8787/";
  expect(isolateConnection().baseURL).toBe("http://127.0.0.1:8787");
});

function mockFetch(
  handler: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>,
): void {
  spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(handler, { preconnect: (): void => {} }),
  );
}

// Lets the queued mirror writes, which run off the command's path, settle.
async function settled(): Promise<void> {
  await new Promise((resolve): void => {
    setTimeout(resolve, 0);
  });
}
