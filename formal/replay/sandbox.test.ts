import { afterAll, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as providers from "../../packages/convex/model/sandboxProviders.ts";
import {
  toWorkspaceRelative,
  computerSandboxTarget,
  resolveAgentSandbox,
} from "../../apps/core/src/harness/tools/filesystem-utils.ts";
import type {
  ResolvedAgentSandbox,
  ResolvedWorkspace,
} from "../../apps/core/src/shared/workspaces.ts";
import {
  parseCoreFrame,
  parseDaemonFrame,
} from "../../apps/core/src/shared/machine-socket.ts";
import { launchScript } from "../../apps/core/src/harness/sandbox/jobs.ts";

const realFetch = globalThis.fetch;
globalThis.fetch = (() => {
  throw new Error("unstubbed network call");
}) as typeof fetch;
afterAll((): void => {
  globalThis.fetch = realFetch;
});

type Provider = (typeof providers.SANDBOX_PROVIDERS)[number];
type Vector =
  | {
      kind: "provider";
      provider: Provider;
      disk: boolean;
      persistent: boolean;
      optIn: boolean;
      holds: boolean;
      capabilities: boolean[];
    }
  | { kind: "path"; path: string; expected: string | null }
  | {
      kind: "computer";
      attached: number[];
      requested: number | null;
      expected: number | null;
    }
  | {
      kind: "bash";
      attached: number[];
      mounted: boolean;
      requested: number | null;
      expected: number | null;
    }
  | {
      kind: "cleanup";
      retained: boolean;
      kept: boolean;
      row: boolean;
      physical: boolean;
      outcomes: boolean[];
    }
  | {
      kind: "hello";
      occupied: boolean;
      previous: string | null;
      incoming: string | null;
      force: boolean;
      expected: boolean;
    };

const lean = spawnSync(
  `${import.meta.dir}/../.lake/build/bin/spec-replay`,
  ["sandbox"],
  {
    cwd: `${import.meta.dir}/..`,
    encoding: "utf8",
    maxBuffer: 1 << 22,
  },
);
if (lean.status !== 0) throw new Error(lean.stderr + lean.stdout);
const vectors = lean.stdout
  .trim()
  .split("\n")
  .map((line): Vector => JSON.parse(line) as Vector);

test.each(vectors)("Lean vector %# $kind", async (vector): Promise<void> => {
  if (vector.kind === "hello") {
    const { machineWebSocketHandler } =
      await import("../../apps/core/src/harness/sandbox/machine-executor.ts");
    const { setStorageForTests } =
      await import("../../apps/core/src/shared/storage.ts");
    type Socket = Parameters<
      NonNullable<typeof machineWebSocketHandler.message>
    >[0];
    const codes: number[] = [];
    let ready = false;
    const socket = (track: boolean): Socket =>
      ({
        data: { accountId: "offline-account" },
        close: (code: number): void => {
          if (track) codes.push(code);
        },
        send: (): number => {
          if (track) ready = true;
          return 1;
        },
      }) as unknown as Socket;
    const first = socket(false);
    const second = socket(true);
    setStorageForTests({
      sandboxConfigs: {
        list: async (): Promise<unknown[]> => [
          {
            name: "machine",
            sandboxId: "offline-machine",
            config: { provider: "machine" },
          },
        ],
      },
      machineConnections: {
        connected: async (): Promise<void> => {},
        disconnected: async (): Promise<void> => {},
      },
    } as unknown as Parameters<typeof setStorageForTests>[0]);
    const send = async (
      sock: Socket,
      instance: string | null,
      force: boolean,
    ): Promise<void> => {
      void machineWebSocketHandler.message(
        sock,
        JSON.stringify({
          type: "hello",
          sandbox: "machine",
          ...(instance === null ? {} : { instance: instance }),
          force: force,
        }),
      );
      await new Promise<void>((resolve): void => {
        setImmediate(resolve);
      });
    };
    try {
      if (vector.occupied) await send(first, vector.previous, false);
      await send(second, vector.incoming, vector.force);
      expect(ready).toBe(vector.expected);
      expect(codes).toEqual(vector.expected ? [] : [4423]);
    } finally {
      void machineWebSocketHandler.close?.(first, 1000, "done");
      void machineWebSocketHandler.close?.(second, 1000, "done");
      await new Promise<void>((resolve): void => {
        setImmediate(resolve);
      });
      setStorageForTests(null);
    }
    return;
  }
  if (vector.kind === "cleanup") {
    await replayCleanup(vector);
    return;
  }
  if (vector.kind === "computer") {
    const picked = computerSandboxTarget(
      vector.attached.map(attachedSandbox),
      vector.requested === null ? undefined : `s${vector.requested}`,
    );
    expect(picked?.name ?? null).toBe(
      vector.expected === null ? null : `s${vector.expected}`,
    );
    return;
  }
  if (vector.kind === "bash") {
    replayBash(vector);
    return;
  }
  if (vector.kind === "path") {
    if (vector.expected === null)
      expect(() => toWorkspaceRelative(vector.path)).toThrow();
    else expect(toWorkspaceRelative(vector.path)).toBe(vector.expected);
    return;
  }
  expect(
    providers.sandboxHoldsWorkspace(vector.disk ? "disk" : "s3", {
      provider: vector.provider,
      persistent: vector.persistent,
      options: { mountAwsS3Buckets: vector.optIn },
    }),
  ).toBe(vector.holds);
  expect([
    providers.STATELESS_SANDBOX_PROVIDERS.has(vector.provider),
    providers.PLATFORM_WORKER_SANDBOX_PROVIDERS.has(vector.provider),
    providers.SNAPSHOT_SANDBOX_PROVIDERS.has(vector.provider),
    providers.SHELL_ONLY_SANDBOX_PROVIDERS.has(vector.provider),
    providers.SUSPEND_SANDBOX_PROVIDERS.has(vector.provider),
    providers.LIVE_TERMINAL_SANDBOX_PROVIDERS.has(vector.provider),
    providers.MOUNT_FLAG_SANDBOX_PROVIDERS.has(vector.provider),
    providers.S3_MOUNT_SANDBOX_PROVIDERS.has(vector.provider),
  ]).toEqual(vector.capabilities);
});

test("named computer never falls back to the remaining attachment", (): void => {
  expect(
    computerSandboxTarget(
      [{ name: "own", sandbox: { provider: "machine" } }],
      "foreign",
    ),
  ).toBeUndefined();
});

test("machine wire frames round trip through real parsers", (): void => {
  const daemon = [
    { type: "hello", sandbox: "own", instance: "one", force: true },
    { type: "credential", token: "token" },
    { type: "computer-result", id: "1", text: "ok" },
    { type: "mcp-result", id: "1", result: { content: [] } },
    { type: "mcp-tools", id: "1", tools: [] },
    {
      type: "result",
      id: "1",
      exitCode: 0,
      stdout: "",
      stderr: "",
      durationMs: 1,
      timedOut: false,
      truncated: false,
    },
  ];
  const core = [
    { type: "ready", sandboxId: "own" },
    {
      type: "exec",
      id: "1",
      code: "true",
      timeoutSeconds: 1,
      outputLimitBytes: 1,
    },
    { type: "computer", id: "1", action: "screenshot" },
    { type: "mcp-call", id: "1", server: "s", tool: "t", args: {} },
    { type: "mcp-list", id: "1", server: "s" },
  ];
  for (const frame of daemon)
    expect(parseDaemonFrame(JSON.stringify(frame))).toEqual(frame);
  for (const frame of core)
    expect(parseCoreFrame(JSON.stringify(frame))).toEqual(frame);
  for (const bad of [null, "{", "{}", '{"type":"exec"}']) {
    expect(parseCoreFrame(bad)).toBeNull();
    expect(parseDaemonFrame(bad)).toBeNull();
  }
});

test("job script checks count before marker creation", (): void => {
  const script = launchScript("/tmp/jobs", "job_1", "/tmp", "true", {
    maxConcurrentJobs: 2,
  });
  expect(script).toContain('if [ "$__running" -ge 2 ]');
  expect(script.indexOf("__running=$(")).toBeLessThan(
    script.indexOf("cat '/proc/sys/kernel/random/boot_id'"),
  );
  expect(() =>
    launchScript("/tmp/jobs", "../bad", "/tmp", "true", {
      maxConcurrentJobs: 2,
    }),
  ).toThrow();
});

test("grep checks a glob-derived search root like an explicit path", async (): Promise<void> => {
  const { default: grepTool } =
    await import("../../apps/core/src/harness/tools/grep.tool.ts");
  const oldUrl = process.env.CLOUDFLARE_WORKER_URL;
  const oldKey = process.env.CLOUDFLARE_WORKER_API_KEY;
  process.env.CLOUDFLARE_WORKER_URL = "https://worker.test";
  process.env.CLOUDFLARE_WORKER_API_KEY = "offline";
  const scripts: string[] = [];
  globalThis.fetch = (async (url, options): Promise<Response> => {
    if (
      !String(url as string | URL).startsWith(
        "https://worker.test/v1/sandboxes/",
      )
    )
      throw new Error("unstubbed fetch");
    const payload = JSON.parse(options?.body as string) as { script: string };
    scripts.push(payload.script);
    return Response.json({
      ok: true,
      timed_out: false,
      duration_ms: 0,
      stdout: "",
      stderr: "",
      exit_code: 0,
    });
  }) as typeof fetch;
  try {
    const tools = grepTool({
      workspaces: [
        {
          name: "own",
          workspaceId: "own",
          namespace: "own",
          config: { storage: { provider: "disk" } },
          sandbox: { provider: "worker" },
        },
      ],
    });
    const options = { toolCallId: "1", messages: [] };
    for (const glob of ["../*.ts", "src/../../x/*"])
      await expect(
        tools.grep?.execute?.({ pattern: "needle", glob: glob }, options),
      ).rejects.toThrow("Invalid path: directory traversal not allowed");
    expect(scripts).toHaveLength(0);
    await tools.grep?.execute?.({ pattern: "needle", glob: "/etc/*" }, options);
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toContain("'-e' 'needle' '--' 'etc'; fi");
  } finally {
    globalThis.fetch = (() => {
      throw new Error("unstubbed network call");
    }) as typeof fetch;
    if (oldUrl === undefined) delete process.env.CLOUDFLARE_WORKER_URL;
    else process.env.CLOUDFLARE_WORKER_URL = oldUrl;
    if (oldKey === undefined) delete process.env.CLOUDFLARE_WORKER_API_KEY;
    else process.env.CLOUDFLARE_WORKER_API_KEY = oldKey;
  }
});

test("G401 cached externalId returns after concurrent provider deletion", async (): Promise<void> => {
  const { runtime } =
    await import("../../apps/core/src/shared/convex/runtime.ts");
  const { reservePlatformSandbox, releasePlatformSandbox } =
    await import("../../apps/core/src/harness/sandbox/platform-worker.ts");
  let wake: () => void = (): void => {};
  let refreshStarted: () => void = (): void => {};
  const refreshing = new Promise<void>((resolve): void => {
    refreshStarted = resolve;
  });
  const refresh = new Promise<void>((resolve): void => {
    wake = resolve;
  });
  const query = spyOn(runtime, "query").mockResolvedValue("physical-old");
  const mutate = spyOn(runtime, "mutate").mockImplementation((async (
    name: string,
  ): Promise<unknown> => {
    if (name === "saveSandboxReservation") {
      refreshStarted();
      await refresh;
      return undefined;
    }
    if (name === "deleteSandboxReservation") return true;
    throw new Error(`unstubbed mutation ${name}`);
  }) as typeof runtime.mutate);
  let deleted = false;
  try {
    const pending = reservePlatformSandbox("worker", "account", "key");
    await refreshing;
    await releasePlatformSandbox(
      "worker",
      "account",
      { namespace: "key", expectedExternalId: "physical-old" },
      async (): Promise<void> => {
        deleted = true;
      },
    );
    wake();
    expect(await pending).toBe("physical-old");
    expect(deleted).toBe(true);
  } finally {
    wake();
    query.mockRestore();
    mutate.mockRestore();
  }
});

// The take succeeds and no config can tear the machine down. `retained` false: another run
// takes the key right after the take, so the hand-back is refused. `kept` false: the
// teardown claim throws.
async function replayCleanup(
  vector: Extract<Vector, { kind: "cleanup" }>,
): Promise<void> {
  const { runtime } =
    await import("../../apps/core/src/shared/convex/runtime.ts");
  const { setStorageForTests } =
    await import("../../apps/core/src/shared/storage.ts");
  const { releaseExpiredSandboxes } =
    await import("../../apps/core/src/shared/sandbox-cleanup.ts");
  type Args = { reservationKey: string; externalId?: string };
  const rows = new Map<string, string>([["key-a", "sbx-a"]]);
  const query = spyOn(runtime, "query").mockImplementation((async (
    name: string,
    args: Args,
  ): Promise<unknown> => {
    if (name === "getSandboxReleaseTarget") {
      return {
        externalId: args.externalId ?? rows.get(args.reservationKey) ?? null,
        instance: null,
      };
    }
    if (name === "getSandboxReservation") {
      return rows.get(args.reservationKey) ?? null;
    }
    throw new Error(`unstubbed query ${name}`);
  }) as typeof runtime.query);
  const mutate = spyOn(runtime, "mutate").mockImplementation((async (
    name: string,
    args: Args & { expectedExternalId?: string },
  ): Promise<unknown> => {
    if (name === "deleteSandboxReservation") {
      if (rows.get(args.reservationKey) !== args.expectedExternalId) {
        return false;
      }
      rows.delete(args.reservationKey);
      if (!vector.retained) rows.set(args.reservationKey, "sbx-other");
      return true;
    }
    if (name === "claimSandboxReservation") {
      if (args.reservationKey.startsWith("teardown:") && !vector.kept) {
        throw new Error("claim failed");
      }
      if (rows.has(args.reservationKey)) return false;
      rows.set(args.reservationKey, args.externalId ?? "");
      return true;
    }
    throw new Error(`unstubbed mutation ${name}`);
  }) as typeof runtime.mutate);
  setStorageForTests({
    sandboxConfigs: { list: async (): Promise<[]> => [] },
  } as unknown as Parameters<typeof setStorageForTests>[0]);
  try {
    const released = await releaseExpiredSandboxes("acct", [
      {
        provider: "e2b",
        reservationKey: "key-a",
        externalId: "sbx-a",
        ttlSeconds: 600,
      },
    ]);
    expect(released.map((): boolean => true)).toEqual(
      vector.outcomes.filter((outcome): boolean => outcome),
    );
    expect([...rows.values()].includes("sbx-a")).toBe(vector.row);
    expect(vector.physical).toBe(true);
  } finally {
    query.mockRestore();
    mutate.mockRestore();
    setStorageForTests(null);
  }
}

function attachedSandbox(id: number): ResolvedAgentSandbox {
  return {
    name: `s${id}`,
    sandbox: {
      provider: "machine",
      controlPlane: { sandboxConfigId: `c${id}` },
    } as ResolvedAgentSandbox["sandbox"],
  };
}

function replayBash(vector: Extract<Vector, { kind: "bash" }>): void {
  const first = vector.attached[0];
  const workspaces = vector.mounted
    ? [
        {
          name: "w",
          workspaceId: "w",
          namespace: "w",
          config: { storage: { provider: "disk" } },
          sandbox: attachedSandbox(first ?? 0).sandbox,
        } as ResolvedWorkspace,
      ]
    : [];
  let picked: string | null;
  try {
    picked =
      resolveAgentSandbox(
        {
          workspaces: workspaces,
          sandboxes: vector.attached.map(attachedSandbox),
        },
        vector.requested === null ? undefined : `s${vector.requested}`,
      )?.name ?? null;
  } catch {
    picked = null;
  }
  expect(picked).toBe(vector.expected === null ? null : `s${vector.expected}`);
}
