import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { CloudflareSandboxExecutor } from "../../../../apps/core/src/harness/sandbox/cloudflare-executor.ts";
import * as instanceStore from "../../../../apps/core/src/harness/sandbox/instance-store.ts";
import type { SandboxExecutorConfig } from "../../../../apps/core/src/harness/sandbox/types.ts";
import * as sandboxInstances from "../../../../apps/core/src/shared/convex/sandbox-instances.ts";
import { drainInFlight } from "../../../../apps/core/src/shared/in-flight.ts";

interface BridgeCall {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}

const EXEC_OK = {
  ok: true,
  exit_code: 0,
  timed_out: false,
  duration_ms: 5,
  stdout: "",
  stderr: "",
  truncated: false,
};
const KEY = "acct:workspace";
const restores: Array<() => void> = [];
const bridge: BridgeCall[] = [];
const mirrored: string[] = [];
let stored: string | null = null;
let running = true;
let execStatus = 200;

function config(
  extra: Partial<SandboxExecutorConfig> = {},
): SandboxExecutorConfig {
  return {
    provider: "cloudflare",
    persistent: true,
    size: "small",
    controlPlane: {
      accountId: "acct",
      name: "box",
      specs: { vcpu: 1, memoryMb: 2048, storageGb: 8 },
    },
    ...extra,
  } as SandboxExecutorConfig;
}

beforeEach((): void => {
  process.env.CLOUDFLARE_SANDBOX_URL = "https://bridge.example.com/";
  process.env.CLOUDFLARE_SANDBOX_API_KEY = "bridge-key";
  stored = null;
  running = true;
  execStatus = 200;
  bridge.length = 0;
  mirrored.length = 0;
  const handler = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const path = url.replace("https://bridge.example.com", "");
    bridge.push({
      method: init?.method ?? "GET",
      path: path,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });
    if (path.endsWith("/exec")) {
      return execStatus === 200
        ? Response.json(EXEC_OK)
        : new Response("refused", { status: execStatus });
    }
    if (init?.method === "GET") return Response.json({ running: running });

    return new Response(null, { status: 204 });
  };
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(handler, { preconnect: (): void => {} }),
  );
  const spies = [
    spyOn(instanceStore, "getSandboxExternalId").mockImplementation(
      async (): Promise<string | null> => stored,
    ),
    spyOn(instanceStore, "claimSandboxInstance").mockImplementation(
      async (_provider, _key, externalId): Promise<boolean> => {
        stored = externalId;

        return true;
      },
    ),
    spyOn(instanceStore, "saveSandboxInstance").mockResolvedValue(undefined),
    spyOn(instanceStore, "deleteSandboxInstance").mockImplementation(
      async (): Promise<void> => {
        mirrored.push("forget");
      },
    ),
    spyOn(sandboxInstances, "upsertSandboxInstance").mockImplementation(
      async (_plane, _provider, key): Promise<void> => {
        mirrored.push(`upsert ${key}`);
      },
    ),
  ];
  restores.push(
    (): void => fetchSpy.mockRestore(),
    ...spies.map(
      (spy): (() => void) =>
        (): void =>
          spy.mockRestore(),
    ),
  );
});

afterEach((): void => {
  for (const restore of restores.splice(0)) restore();
  delete process.env.CLOUDFLARE_SANDBOX_URL;
  delete process.env.CLOUDFLARE_SANDBOX_API_KEY;
});

describe("cloudflare prewarm", () => {
  test("starts a reserved container ahead of use and mirrors it", async (): Promise<void> => {
    await new CloudflareSandboxExecutor(config()).prewarm({
      reservationKey: KEY,
    });
    await drainInFlight();

    expect(bridge).toHaveLength(1);
    expect(bridge[0]?.path).toBe(`/v1/sandboxes/${stored}/exec`);
    expect(bridge[0]?.body).toMatchObject({
      argv: ["true"],
      timeoutMs: 30_000,
      outputLimitBytes: 1024,
      instance: "standard-2",
    });
    expect(mirrored).toEqual([`upsert ${KEY}`]);
  });

  test("does nothing for an ephemeral sandbox", async (): Promise<void> => {
    await new CloudflareSandboxExecutor(config({ persistent: false })).prewarm({
      reservationKey: KEY,
    });

    expect(bridge).toEqual([]);
  });

  test("does nothing without a reservation key", async (): Promise<void> => {
    await new CloudflareSandboxExecutor(config()).prewarm({});

    expect(bridge).toEqual([]);
  });

  test("does nothing when no container can be reserved without an account", async (): Promise<void> => {
    await new CloudflareSandboxExecutor(
      config({ controlPlane: undefined }),
    ).prewarm({
      reservationKey: KEY,
    });

    expect(bridge).toEqual([]);
  });

  test("mirrors nothing when the container never answered", async (): Promise<void> => {
    execStatus = 401;

    await expect(
      new CloudflareSandboxExecutor(config()).prewarm({ reservationKey: KEY }),
    ).rejects.toThrow("failed (401)");
    await drainInFlight();

    expect(mirrored).toEqual([]);
  });
});

describe("cloudflare instance info", () => {
  test("reports a running container", async (): Promise<void> => {
    stored = "fp-p-1";

    expect(
      await new CloudflareSandboxExecutor(config()).getInstanceInfo({
        reservationKey: KEY,
      }),
    ).toEqual({ externalId: "fp-p-1", state: "running" });
  });

  test("reports no container for a reservation that has none", async (): Promise<void> => {
    expect(
      await new CloudflareSandboxExecutor(config()).getInstanceInfo({
        reservationKey: KEY,
      }),
    ).toBeNull();
    expect(bridge).toEqual([]);
  });

  test("reports a stopped container as absent", async (): Promise<void> => {
    stored = "fp-p-1";
    running = false;

    expect(
      await new CloudflareSandboxExecutor(config()).getInstanceInfo({
        reservationKey: KEY,
      }),
    ).toBeNull();
  });
});
