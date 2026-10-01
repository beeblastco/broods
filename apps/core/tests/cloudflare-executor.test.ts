import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import * as instanceStore from "../src/harness/sandbox/instance-store.ts";
import * as sandboxInstances from "../src/shared/convex/sandbox-instances.ts";
import { CloudflareSandboxExecutor } from "../src/harness/sandbox/cloudflare-executor.ts";
import type { SandboxExecutorConfig } from "../src/harness/sandbox/types.ts";

interface BridgeCall {
  method: string;
  url: string;
  authorization: string | null;
  body: Record<string, unknown> | null;
}

const calls: BridgeCall[] = [];
const restores: (() => void)[] = [];
let stored: string | null = null;
let claimWins = true;

beforeEach((): void => {
  process.env.CLOUDFLARE_SANDBOX_URL = "https://bridge.example.com/";
  process.env.CLOUDFLARE_SANDBOX_API_KEY = "bridge-key";
  stored = null;
  claimWins = true;
  calls.length = 0;
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const headers = new Headers(init?.headers);
    calls.push({
      method: init?.method ?? "GET",
      url: String(input),
      authorization: headers.get("Authorization"),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });
    if (String(input).endsWith("/exec"))
      return Response.json({
        exitCode: 0,
        stdout: "ok\n",
        stderr: "",
        truncated: false,
        timedOut: false,
      });

    return new Response(null, { status: 204 });
  }) as typeof fetch);
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
  ).mockImplementation(async (): Promise<void> => {});
  restores.push(
    (): void => fetchSpy.mockRestore(),
    (): void => getSpy.mockRestore(),
    (): void => claimSpy.mockRestore(),
    (): void => saveSpy.mockRestore(),
    (): void => upsertSpy.mockRestore(),
  );
});

afterEach((): void => {
  for (const restore of restores.splice(0)) restore();
  delete process.env.CLOUDFLARE_SANDBOX_URL;
  delete process.env.CLOUDFLARE_SANDBOX_API_KEY;
});

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

it("runs an ephemeral command on the bridge and destroys its container", async (): Promise<void> => {
  const result = await new CloudflareSandboxExecutor(config).run({
    code: "echo ok",
    timeoutSeconds: 10,
    outputLimitBytes: 1024,
    envVars: { PATH: "/evil", CALL_VAR: "b" },
    args: ["one"],
  });

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
    env: { ACCOUNT_VAR: "a", CALL_VAR: "b" },
    timeoutMs: 10_000,
    enableInternet: false,
    instance: "standard-3",
  });
  const argv = exec?.body?.argv;
  if (!Array.isArray(argv)) throw new Error("exec body has no argv");
  expect(argv.slice(-3)).toEqual(["/workspace", "echo ok", "one"]);
  expect(destroy?.method).toBe("DELETE");
  expect(destroy?.url).toBe(exec?.url.replace(/\/exec$/, ""));
});

it("reserves one persistent container and keeps it across runs", async (): Promise<void> => {
  const executor = new CloudflareSandboxExecutor({
    ...config,
    persistent: true,
  });
  const request = {
    code: "true",
    reservationKey: "acct:workspace",
    timeoutSeconds: 10,
    outputLimitBytes: 1024,
  };
  await executor.run(request);
  await executor.run(request);

  expect(calls.map((call) => call.method)).toEqual(["POST", "POST"]);
  expect(calls[0]?.url).toBe(calls[1]?.url);
  expect(calls[0]?.url).toContain(`/v1/sandboxes/${stored}/exec`);
});

it("takes the winner's container when it loses the reservation race", async (): Promise<void> => {
  claimWins = false;
  await new CloudflareSandboxExecutor({ ...config, persistent: true }).run({
    code: "true",
    reservationKey: "acct:workspace",
    timeoutSeconds: 10,
    outputLimitBytes: 1024,
  });

  expect(calls[0]?.url).toContain("/v1/sandboxes/winner-id/exec");
});

it("runs a persistent config without an account as ephemeral", async (): Promise<void> => {
  await new CloudflareSandboxExecutor({
    ...config,
    persistent: true,
    controlPlane: undefined,
  }).run({
    code: "true",
    reservationKey: "acct:workspace",
    timeoutSeconds: 10,
    outputLimitBytes: 1024,
  });

  expect(calls.map((call) => call.method)).toEqual(["POST", "DELETE"]);
  expect(calls[0]?.url).toContain("/v1/sandboxes/fp-e-");
});

it("keeps the result when the ephemeral destroy fails", async (): Promise<void> => {
  const executor = new CloudflareSandboxExecutor(config);
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
    input: string | URL | Request,
  ): Promise<Response> =>
    String(input).endsWith("/exec")
      ? Response.json({
          exitCode: 0,
          stdout: "ok\n",
          stderr: "",
          truncated: false,
          timedOut: false,
        })
      : new Response("boom", { status: 500 })) as typeof fetch);
  restores.unshift((): void => fetchSpy.mockRestore());

  const result = await executor.run({
    code: "echo ok",
    timeoutSeconds: 10,
    outputLimitBytes: 1024,
  });

  expect(result.ok).toBe(true);
});
