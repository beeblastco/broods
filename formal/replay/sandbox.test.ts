import { afterAll, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as providers from "../../packages/convex/model/sandboxProviders.ts";
import {
  toWorkspaceRelative,
  computerSandboxTarget,
} from "../../apps/core/src/harness/tools/filesystem-utils.ts";
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

test.failing(
  "G402 grep glob fallback root bypasses lexical traversal check",
  async (): Promise<void> => {
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
      try {
        await tools.grep?.execute?.(
          { pattern: "needle", glob: "../*.ts" },
          { toolCallId: "1", messages: [] },
        );
      } catch {
        // A refusal before execution is the expected intended behaviour.
      }
      expect(scripts).toHaveLength(0);
    } finally {
      globalThis.fetch = (() => {
        throw new Error("unstubbed network call");
      }) as typeof fetch;
      if (oldUrl === undefined) delete process.env.CLOUDFLARE_WORKER_URL;
      else process.env.CLOUDFLARE_WORKER_URL = oldUrl;
      if (oldKey === undefined) delete process.env.CLOUDFLARE_WORKER_API_KEY;
      else process.env.CLOUDFLARE_WORKER_API_KEY = oldKey;
    }
  },
);

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
