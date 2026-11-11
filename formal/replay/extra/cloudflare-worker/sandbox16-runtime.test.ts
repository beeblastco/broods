import { describe, expect, mock, test } from "bun:test";

class FakeWorkerEntrypoint {}

await mock.module("cloudflare:workers", (): object => ({
  WorkerEntrypoint: FakeWorkerEntrypoint,
}));

const { Runtime } =
  await import("../../../../apps/cloudflare-worker/src/runtime.ts");

function exec(
  script: string,
  overrides: { timeoutMs?: number; outputLimitBytes?: number },
): ReturnType<InstanceType<typeof Runtime>["exec"]> {
  return new Runtime({} as never, {} as never).exec(
    {
      script: script,
      args: [],
      cwd: "/work",
      env: {},
      timeoutMs: overrides.timeoutMs ?? 5000,
      outputLimitBytes: overrides.outputLimitBytes ?? 1024,
      persist: false,
      enableInternet: false,
    } as never,
    null,
  );
}

describe("capped", (): void => {
  test("output that fits the byte limit is kept whole", async (): Promise<void> => {
    const answer = await exec("echo hi", { outputLimitBytes: 8 });

    expect(answer.result.stdout).toBe("hi\n");
    expect(answer.result.truncated).toBe(false);
  });
});

describe("Runtime.exec deadline", (): void => {
  test("a command that runs past its deadline is timed out", async (): Promise<void> => {
    const answer = await exec("while true; do sleep 1; done", {
      timeoutMs: 50,
    });

    expect(answer.result.ok).toBe(false);
    expect(answer.result.timed_out).toBe(true);
  });
});
