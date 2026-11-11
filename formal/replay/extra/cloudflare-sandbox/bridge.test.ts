import { describe, expect, mock, test } from "bun:test";

class FakeDurableObject {
  readonly ctx: unknown;
  readonly env: unknown;

  constructor(ctx: unknown, env: unknown) {
    this.ctx = ctx;
    this.env = env;
  }
}

await mock.module("cloudflare:workers", (): object => ({
  DurableObject: FakeDurableObject,
}));

const bridge = await import("../../../../apps/cloudflare-sandbox/src/index.ts");
const SandboxClass = bridge.Sandbox as unknown as new (
  ctx: unknown,
  env: unknown,
) => SandboxApi;

interface ExecAnswer {
  ok: boolean;
  exit_code: number | null;
  timed_out: boolean;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

interface SandboxApi {
  exec: (request: typeof EXEC_REQUEST) => Promise<ExecAnswer>;
  destroy: () => Promise<void>;
  status: () => { running: boolean };
  fetch: (request: Request) => Promise<Response>;
}

interface ProcessShape {
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  stdin?: WritableStream<Uint8Array> | null;
  exitCode: Promise<number>;
}

const EXEC_REQUEST = {
  argv: ["bash", "-c", "true"],
  env: { A: "1" },
  timeoutMs: 1000,
  outputLimitBytes: 4,
  idleTimeoutSeconds: 60,
  enableInternet: false,
  instance: "lite" as const,
};

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start: function (controller): void {
      for (const chunk of chunks)
        controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
}

function failingStream(): ReadableStream<Uint8Array> {
  let pulls = 0;

  return new ReadableStream<Uint8Array>({
    pull: function (controller): void {
      pulls += 1;
      if (pulls === 1) controller.enqueue(new TextEncoder().encode("ab"));
      else controller.error(new Error("killed"));
    },
  });
}

function finishedProcess(overrides: Partial<ProcessShape> = {}): ProcessShape {
  return {
    stdout: streamOf("ok"),
    stderr: streamOf(),
    exitCode: Promise.resolve(0),
    ...overrides,
  };
}

interface ContainerOptions {
  running?: boolean;
  image?: string | undefined;
  process?: ProcessShape;
  setInactivityTimeout?: () => Promise<void>;
  execError?: Error;
}

function fakeContext(
  options: ContainerOptions,
  stored: Map<string, unknown> = new Map(),
): {
  ctx: unknown;
  destroy: ReturnType<typeof mock>;
  start: ReturnType<typeof mock>;
} {
  const destroy = mock(async (): Promise<void> => {});
  const start = mock((): void => {});
  const container = {
    running: options.running ?? false,
    images: {
      sandbox: "image" in options ? options.image : "registry/sandbox:1",
    },
    start: start,
    destroy: destroy,
    setInactivityTimeout:
      options.setInactivityTimeout ?? (async (): Promise<void> => {}),
    exec: async (): Promise<ProcessShape> => {
      if (options.execError) throw options.execError;

      return options.process ?? finishedProcess();
    },
  };

  return {
    ctx: {
      container: container,
      storage: {
        kv: {
          get: (key: string): unknown => stored.get(key),
          put: (key: string, value: unknown): void =>
            void stored.set(key, value),
        },
      },
      blockConcurrencyWhile: async (run: () => Promise<void>): Promise<void> =>
        run(),
    },
    destroy: destroy,
    start: start,
  };
}

function sandboxFor(
  options: ContainerOptions,
  stored?: Map<string, unknown>,
): {
  sandbox: SandboxApi;
  destroy: ReturnType<typeof mock>;
  start: ReturnType<typeof mock>;
} {
  const { ctx, destroy, start } = fakeContext(options, stored);

  return { sandbox: new SandboxClass(ctx, {}), destroy: destroy, start: start };
}

function upgradeRequest(url: string): Request {
  return new Request(url, { headers: { Upgrade: "websocket" } });
}

describe("Sandbox.exec", () => {
  test("starts a stopped container and answers the command's output", async () => {
    const { sandbox, start } = sandboxFor({});

    const answer = await sandbox.exec(EXEC_REQUEST);

    expect(start).toHaveBeenCalledTimes(1);
    expect(answer).toMatchObject({
      ok: true,
      exit_code: 0,
      timed_out: false,
      stdout: "ok",
    });
  });

  test("caps output at the limit and reports truncation", async () => {
    const { sandbox } = sandboxFor({
      process: finishedProcess({ stdout: streamOf("abc", "defg") }),
    });

    const answer = await sandbox.exec(EXEC_REQUEST);

    expect(answer).toMatchObject({ stdout: "abcd", truncated: true });
  });

  test("keeps what arrived before a stream fails", async () => {
    const { sandbox } = sandboxFor({
      process: finishedProcess({ stdout: failingStream() }),
    });

    expect((await sandbox.exec(EXEC_REQUEST)).stdout).toBe("ab");
  });

  test("reads a missing stream as empty", async () => {
    const { sandbox } = sandboxFor({
      process: finishedProcess({ stdout: null, stderr: null }),
    });

    expect((await sandbox.exec(EXEC_REQUEST)).stdout).toBe("");
  });

  test("a non-zero exit is reported as such", async () => {
    const { sandbox } = sandboxFor({
      process: finishedProcess({ exitCode: Promise.resolve(3) }),
    });

    expect(await sandbox.exec(EXEC_REQUEST)).toMatchObject({
      ok: false,
      exit_code: 3,
    });
  });

  test("an unreadable exit code is null", async () => {
    const { sandbox } = sandboxFor({
      process: finishedProcess({ exitCode: Promise.reject(new Error("gone")) }),
    });

    expect(await sandbox.exec(EXEC_REQUEST)).toMatchObject({
      ok: false,
      exit_code: null,
    });
  });

  test("timeout's exit status past the deadline reads as timed out", async () => {
    const { sandbox } = sandboxFor({
      process: finishedProcess({
        exitCode: new Promise<number>((resolve): void => {
          setTimeout((): void => resolve(124), 15);
        }),
      }),
    });

    const answer = await sandbox.exec({ ...EXEC_REQUEST, timeoutMs: 1 });

    expect(answer).toMatchObject({
      ok: false,
      exit_code: null,
      timed_out: true,
    });
  });

  test("a container under another launch policy is replaced", async () => {
    const stored = new Map<string, unknown>([["launch", "internet:lite"]]);
    const { sandbox, destroy } = sandboxFor({ running: true }, stored);

    await sandbox.exec(EXEC_REQUEST);

    expect(destroy).toHaveBeenCalledTimes(1);
  });

  test("a failed inactivity window destroys the container", async () => {
    const { sandbox, destroy } = sandboxFor({
      setInactivityTimeout: async (): Promise<void> => {
        throw new Error("no window");
      },
    });

    await expect(sandbox.exec(EXEC_REQUEST)).rejects.toThrow("no window");
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  test("an exec failure propagates", async () => {
    const { sandbox } = sandboxFor({ execError: new Error("refused") });

    await expect(sandbox.exec(EXEC_REQUEST)).rejects.toThrow("refused");
  });

  test("a config without the image refuses to start", async () => {
    const { sandbox } = sandboxFor({ image: undefined });

    await expect(sandbox.exec(EXEC_REQUEST)).rejects.toThrow(
      "must define the sandbox image",
    );
  });

  test("a missing binding is an error", async () => {
    const sandbox = new SandboxClass(
      { storage: { kv: { get: (): undefined => undefined } } },
      {},
    );

    await expect(sandbox.exec(EXEC_REQUEST)).rejects.toThrow(
      "container binding",
    );
  });
});

describe("Sandbox lifecycle", () => {
  test.each([
    [true, 1],
    [false, 0],
  ])("destroy with running=%p destroys %p times", async (running, times) => {
    const { sandbox, destroy } = sandboxFor({ running: running });

    await sandbox.destroy();

    expect(destroy).toHaveBeenCalledTimes(times);
  });

  test.each([[true], [false]])("status reports running=%p", (running) => {
    expect(sandboxFor({ running: running }).sandbox.status()).toEqual({
      running: running,
    });
  });
});

describe("Sandbox.fetch", () => {
  test("refuses anything but a WebSocket upgrade", async () => {
    const { sandbox } = sandboxFor({ running: true });

    expect((await sandbox.fetch(new Request("https://b/x"))).status).toBe(426);
  });

  test("refuses a stopped sandbox", async () => {
    const { sandbox } = sandboxFor({ running: false });

    expect((await sandbox.fetch(upgradeRequest("https://b/x"))).status).toBe(
      409,
    );
  });

  test("a shell with no stdin is an error", async () => {
    const { sandbox } = sandboxFor({
      running: true,
      process: finishedProcess({ stdin: null }),
    });

    await expect(
      sandbox.fetch(upgradeRequest("https://b/x?name=a b")),
    ).rejects.toThrow("no stdin");
  });
});
