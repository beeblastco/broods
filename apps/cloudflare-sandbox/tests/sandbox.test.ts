import { expect, it, mock } from "bun:test";

interface StartOptions {
  enableInternet: boolean;
  instance: string;
}

interface ExecCall {
  argv: string[];
  env: Record<string, string>;
  timeoutMs: number;
  outputLimitBytes: number;
  idleTimeoutSeconds: number;
  enableInternet: boolean;
  instance: "lite";
}

interface SandboxModule {
  Sandbox: new (
    ctx: object,
    env: object,
  ) => { exec(request: ExecCall): Promise<{ ok: boolean }> };
}

await mock.module("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: object;
    constructor(ctx: object) {
      this.ctx = ctx;
    }
  },
}));
// Lazy so the stub above is in place first; a computed path keeps src out of the Bun-typed program.
const { Sandbox }: SandboxModule = await import(
  new URL("../src/index.ts", import.meta.url).href
);

it("refuses a call for another network policy while the Container boots", async (): Promise<void> => {
  const booted = Promise.withResolvers<void>();
  const starts: StartOptions[] = [];
  const ranUnder: { wanted: boolean; got: boolean | undefined }[] = [];
  const kv = new Map<string, unknown>();
  const container = {
    running: false,
    images: { sandbox: "sandbox:test" },
    start: (options: StartOptions): void => void starts.push(options),
    destroy: async (): Promise<void> => {
      container.running = false;
    },
    setInactivityTimeout: async (): Promise<void> => {},
    exec: async (
      _argv: string[],
      options: { env: Record<string, string> },
    ): Promise<object> => {
      await booted.promise;
      container.running = true;
      ranUnder.push({
        wanted: options.env.WANT === "internet",
        got: starts.at(-1)?.enableInternet,
      });

      return { stdout: null, stderr: null, exitCode: Promise.resolve(0) };
    },
  };
  const sandbox = new Sandbox(
    {
      container: container,
      storage: {
        kv: {
          get: (key: string): unknown => kv.get(key),
          put: (key: string, value: unknown): void => void kv.set(key, value),
        },
      },
    },
    {},
  );
  const call = (internet: boolean): ExecCall => ({
    argv: ["true"],
    env: { WANT: internet ? "internet" : "offline" },
    timeoutMs: 1000,
    outputLimitBytes: 1024,
    idleTimeoutSeconds: 60,
    enableInternet: internet,
    instance: "lite",
  });

  const offline = sandbox.exec(call(false));
  const online = sandbox.exec(call(true));
  booted.resolve();
  const results = await Promise.allSettled([offline, online]);

  expect(results[0].status).toBe("fulfilled");
  expect(results[1].status).toBe("rejected");
  expect(ranUnder.filter((run) => run.wanted !== run.got)).toEqual([]);
});
