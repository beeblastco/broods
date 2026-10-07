/**
 * The cloudflare executor against a mocked bridge Worker: what it sends, when
 * it reserves, reuses and destroys a Container, and which instance rows it
 * mirrors for metering. The bridge itself needs workerd and Docker, so it is
 * not run here.
 */

import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import { drainInFlight } from "../src/shared/in-flight.ts";
import * as instanceStore from "../src/harness/sandbox/instance-store.ts";
import * as sandboxInstances from "../src/shared/convex/sandbox-instances.ts";
import {
  CloudflareSandboxExecutor,
  cloudflareConnection,
} from "../src/harness/sandbox/cloudflare-executor.ts";
import type { SandboxExecutorConfig } from "../src/harness/sandbox/types.ts";

// A successful bridge exec answer, in the shared exec contract's shape.
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
  provider: "cloudflare",
  network: { mode: "deny-all" },
  size: "medium",
  envVars: { ACCOUNT_VAR: "a" },
  controlPlane: {
    accountId: "acct",
    name: "box",
    specs: { vcpu: 2, memoryMb: 4096, storageGb: 16 },
  },
};
const request = {
  code: "true",
  reservationKey: "acct:workspace",
  timeoutSeconds: 10,
  outputLimitBytes: 1024,
};

interface BridgeCall {
  method: string;
  url: string;
  authorization: string | null;
  body: Record<string, unknown> | null;
}

const calls: BridgeCall[] = [];
const mirrored: string[] = [];
const restores: (() => void)[] = [];
let stored: string | null = null;
let claimWins = true;

beforeEach((): void => {
  process.env.CLOUDFLARE_SANDBOX_URL = "https://bridge.example.com/";
  process.env.CLOUDFLARE_SANDBOX_API_KEY = "bridge-key";
  stored = null;
  claimWins = true;
  calls.length = 0;
  mirrored.length = 0;
  const bridge = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const headers = new Headers(init?.headers);
    calls.push({
      method: init?.method ?? "GET",
      url: urlOf(input),
      authorization: headers.get("Authorization"),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });

    return urlOf(input).endsWith("/exec")
      ? Response.json(EXEC_OK)
      : new Response(null, { status: 204 });
  };
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(bridge, { preconnect: (): void => {} }),
  );
  const getSpy = spyOn(
    instanceStore,
    "getSandboxExternalId",
  ).mockImplementation(async (): Promise<string | null> => stored);
  const claimSpy = spyOn(
    instanceStore,
    "claimSandboxInstance",
  ).mockImplementation(
    async (_provider, _key, externalId): Promise<boolean> => {
      if (claimWins) stored = externalId;
      else stored = "winner-id";

      return claimWins;
    },
  );
  const saveSpy = spyOn(
    instanceStore,
    "saveSandboxInstance",
  ).mockImplementation(async (): Promise<void> => {});
  const upsertSpy = spyOn(
    sandboxInstances,
    "upsertSandboxInstance",
  ).mockImplementation(
    async (_plane, _provider, key, _id, _meta, options): Promise<void> => {
      mirrored.push(`upsert ${key} ${options?.ephemeral === true}`);
    },
  );
  const removeSpy = spyOn(
    sandboxInstances,
    "removeSandboxInstance",
  ).mockImplementation(async (_account, key): Promise<void> => {
    mirrored.push(`remove ${key}`);
  });
  restores.push(
    (): void => fetchSpy.mockRestore(),
    (): void => getSpy.mockRestore(),
    (): void => claimSpy.mockRestore(),
    (): void => saveSpy.mockRestore(),
    (): void => upsertSpy.mockRestore(),
    (): void => removeSpy.mockRestore(),
  );
});

afterEach((): void => {
  for (const restore of restores.splice(0)) restore();
  delete process.env.CLOUDFLARE_SANDBOX_URL;
  delete process.env.CLOUDFLARE_SANDBOX_API_KEY;
});

it("runs an ephemeral command on the bridge, meters it and destroys its container", async (): Promise<void> => {
  const result = await new CloudflareSandboxExecutor(config).run({
    code: "echo ok",
    timeoutSeconds: 10,
    outputLimitBytes: 1024,
    envVars: { PATH: "/evil", CALL_VAR: "b" },
    args: ["one"],
    principal: { accountId: "acct", agentId: "agent", runToken: "tok" },
  });
  await drainInFlight();

  expect(result).toMatchObject({
    ok: true,
    stdout: "ok\n",
    provider: "cloudflare",
  });
  const [exec, destroy] = calls;
  expect(exec?.url).toMatch(
    /^https:\/\/bridge\.example\.com\/v1\/sandboxes\/fp-e-[0-9a-f-]+\/exec$/,
  );
  expect(exec?.authorization).toBe("Bearer bridge-key");
  expect(exec?.body).toMatchObject({
    env: { ACCOUNT_VAR: "a", CALL_VAR: "b", BROODS_AGENT_ID: "agent" },
    timeoutMs: 10_000,
    enableInternet: false,
    instance: "standard-3",
  });
  const argv = exec?.body?.argv;
  if (!Array.isArray(argv)) throw new Error("exec body has no argv");
  expect(argv.slice(-3)).toEqual(["/workspace", "echo ok", "one"]);
  expect(destroy?.method).toBe("DELETE");
  expect(destroy?.url).toBe(exec?.url.replace(/\/exec$/, ""));
  const id = exec?.url.split("/").at(-2);
  expect(mirrored).toEqual([`upsert ${id} true`, `remove ${id}`]);
});

it("reserves one persistent container, keeps it across runs and mirrors it", async (): Promise<void> => {
  const executor = new CloudflareSandboxExecutor({
    ...config,
    persistent: true,
  });
  await executor.run(request);
  await executor.run(request);
  await settled();

  expect(calls.map((call): string => call.method)).toEqual(["POST", "POST"]);
  expect(calls[0]?.url).toBe(calls[1]?.url);
  expect(calls[0]?.url).toContain(`/v1/sandboxes/${stored}/exec`);
  expect(mirrored).toEqual([
    "upsert acct:workspace false",
    "upsert acct:workspace false",
  ]);
});

it("never mirrors a reservation whose first start failed, so it is not billed", async (): Promise<void> => {
  const refused = async (): Promise<Response> =>
    new Response("Unauthorized", { status: 401 });
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(refused, { preconnect: (): void => {} }),
  );
  restores.unshift((): void => fetchSpy.mockRestore());

  const failure = await new CloudflareSandboxExecutor({
    ...config,
    persistent: true,
  })
    .run(request)
    .then(
      (): string => "ran",
      (error: unknown): string => String(error),
    );
  await settled();

  expect(failure).toContain("failed (401)");
  expect(mirrored).toEqual([]);
});

it("takes the winner's container when it loses the reservation race", async (): Promise<void> => {
  claimWins = false;
  await new CloudflareSandboxExecutor({ ...config, persistent: true }).run(
    request,
  );

  expect(calls[0]?.url).toContain("/v1/sandboxes/winner-id/exec");
});

it("reuses an existing reservation without an account, as the dashboard console runs", async (): Promise<void> => {
  stored = "fp-p-existing";
  await new CloudflareSandboxExecutor({
    ...config,
    persistent: true,
    controlPlane: undefined,
  }).run(request);

  expect(calls.map((call): string => call.method)).toEqual(["POST"]);
  expect(calls[0]?.url).toContain("/v1/sandboxes/fp-p-existing/exec");
});

it("runs a persistent config with no account and no reservation as ephemeral", async (): Promise<void> => {
  await new CloudflareSandboxExecutor({
    ...config,
    persistent: true,
    controlPlane: undefined,
  }).run(request);

  expect(calls.map((call): string => call.method)).toEqual(["POST", "DELETE"]);
  expect(calls[0]?.url).toContain("/v1/sandboxes/fp-e-");
});

it("keeps the result when the ephemeral destroy fails", async (): Promise<void> => {
  const executor = new CloudflareSandboxExecutor(config);
  const failingDelete = async (
    input: string | URL | Request,
  ): Promise<Response> =>
    urlOf(input).endsWith("/exec")
      ? Response.json(EXEC_OK)
      : new Response("boom", { status: 500 });
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(failingDelete, { preconnect: (): void => {} }),
  );
  restores.unshift((): void => fetchSpy.mockRestore());

  const result = await executor.run({
    code: "echo ok",
    timeoutSeconds: 10,
    outputLimitBytes: 1024,
  });

  expect(result.ok).toBe(true);
});

it("refuses a plain-HTTP bridge outside loopback, since every call carries the key", (): void => {
  process.env.CLOUDFLARE_SANDBOX_URL = "http://bridge.example.com";
  expect(cloudflareConnection).toThrow("must be https outside loopback");
  process.env.CLOUDFLARE_SANDBOX_URL = "http://127.0.0.1:8795/";
  expect(cloudflareConnection().baseURL).toBe("http://127.0.0.1:8795");
});

// Lets the queued mirror writes, which run off the command's path, settle.
async function settled(): Promise<void> {
  await new Promise((resolve): void => {
    setTimeout(resolve, 0);
  });
}

function urlOf(input: string | URL | Request): string {
  if (typeof input === "string") return input;

  return input instanceof URL ? input.href : input.url;
}
