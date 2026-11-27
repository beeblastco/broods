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
  const fake = fakeSandbox();

  const offline = fake.sandbox.exec(call(false));
  const online = fake.sandbox.exec(call(true));
  fake.booted.resolve();
  const results = await Promise.allSettled([offline, online]);

  expect(results[0].status).toBe("fulfilled");
  expect(results[1].status).toBe("rejected");
  expect(fake.mismatches()).toEqual([]);
});

it("keeps refusing after an exec from the replaced Container settles", async (): Promise<void> => {
  const fake = fakeSandbox();
  fake.booted.resolve();
  await fake.sandbox.exec(call(true));
  const inFlight = fake.sandbox.exec(call(true, true));
  await Bun.sleep(0);

  const offline = fake.sandbox.exec(call(false));
  await inFlight.catch((): void => {});
  const online = fake.sandbox.exec(call(true));
  fake.destroyed.resolve();
  const results = await Promise.allSettled([offline, online]);

  expect(results[0].status).toBe("fulfilled");
  expect(results[1].status).toBe("rejected");
  expect(fake.mismatches()).toEqual([]);
});

function call(internet: boolean, hold = false): ExecCall {
  return {
    argv: ["true"],
    env: {
      WANT: internet ? "internet" : "offline",
      ...(hold ? { HOLD: "1" } : {}),
    },
    timeoutMs: 1000,
    outputLimitBytes: 1024,
    idleTimeoutSeconds: 60,
    enableInternet: internet,
    instance: "lite",
  };
}

// An exec waits for `booted`; with HOLD it hangs until destroy() rejects it, as a real one does.
function fakeSandbox(): {
  sandbox: InstanceType<SandboxModule["Sandbox"]>;
  booted: PromiseWithResolvers<void>;
  destroyed: PromiseWithResolvers<void>;
  mismatches: () => { wanted: boolean; got: boolean | undefined }[];
} {
  const booted = Promise.withResolvers<void>();
  const destroyed = Promise.withResolvers<void>();
  const starts: StartOptions[] = [];
  const ranUnder: { wanted: boolean; got: boolean | undefined }[] = [];
  const held: ((error: Error) => void)[] = [];
  const kv = new Map<string, unknown>();
  const container = {
    running: false,
    images: { sandbox: "sandbox:test" },
    start: (options: StartOptions): void => void starts.push(options),
    destroy: async (): Promise<void> => {
      container.running = false;
      for (const reject of held.splice(0)) reject(new Error("destroyed"));
      await destroyed.promise;
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
      if (options.env.HOLD)
        await new Promise<void>((_resolve, reject) => void held.push(reject));

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

  return {
    sandbox: sandbox,
    booted: booted,
    destroyed: destroyed,
    mismatches: (): { wanted: boolean; got: boolean | undefined }[] =>
      ranUnder.filter((run) => run.wanted !== run.got),
  };
}
