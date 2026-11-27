import { describe, expect, mock, test } from "bun:test";

class FakeWorkerEntrypoint {}

await mock.module("cloudflare:workers", (): object => ({
  WorkerEntrypoint: FakeWorkerEntrypoint,
}));

const { Runtime } =
  await import("../../../../apps/cloudflare-worker/src/runtime.ts");

interface ExecCase {
  name: string;
  script: string;
  args: string[];
  outputLimitBytes: number;
  ok: boolean;
  exitCode: number;
  stdout: string;
  truncated: boolean;
}

const CASES: ExecCase[] = [
  {
    name: "plain output",
    script: "echo hello",
    args: [],
    outputLimitBytes: 1024,
    ok: true,
    exitCode: 0,
    stdout: "hello\n",
    truncated: false,
  },
  {
    name: "positional arguments",
    script: 'echo "$1-$2"',
    args: ["a b", "c"],
    outputLimitBytes: 1024,
    ok: true,
    exitCode: 0,
    stdout: "a b-c\n",
    truncated: false,
  },
  {
    name: "a quote in an argument",
    script: 'echo "$1"',
    args: ["it's"],
    outputLimitBytes: 1024,
    ok: true,
    exitCode: 0,
    stdout: "it's\n",
    truncated: false,
  },
  {
    name: "output past the limit",
    script: "echo 0123456789",
    args: [],
    outputLimitBytes: 4,
    ok: true,
    exitCode: 0,
    stdout: "0123",
    truncated: true,
  },
  {
    name: "a failing command",
    script: "exit 3",
    args: [],
    outputLimitBytes: 1024,
    ok: false,
    exitCode: 3,
    stdout: "",
    truncated: false,
  },
];

describe("worker runtime exec", (): void => {
  test.each(CASES)("$name", async (entry: ExecCase): Promise<void> => {
    const runtime = new Runtime({} as never, {} as never);
    const answer = await runtime.exec(
      {
        script: entry.script,
        args: entry.args,
        cwd: "/work",
        env: {},
        timeoutMs: 5000,
        outputLimitBytes: entry.outputLimitBytes,
        persist: false,
        enableInternet: false,
      } as never,
      null,
    );

    expect(answer.state).toBeNull();
    expect(answer.result.ok).toBe(entry.ok);
    expect(answer.result.exit_code).toBe(entry.exitCode);
    expect(answer.result.stdout).toBe(entry.stdout);
    expect(answer.result.truncated).toBe(entry.truncated);
  });

  test("a persisted file survives, and an unchanged disk says so", async (): Promise<void> => {
    const runtime = new Runtime({} as never, {} as never);
    const request = {
      args: [],
      cwd: "/work",
      env: {},
      timeoutMs: 5000,
      outputLimitBytes: 1024,
      persist: true,
      enableInternet: false,
    };
    const first = await runtime.exec(
      { ...request, script: "echo kept > /work/f" } as never,
      null,
    );
    expect(first.state).toBeInstanceOf(Uint8Array);

    const second = await runtime.exec(
      { ...request, script: "cat /work/f" } as never,
      first.state as Uint8Array,
    );
    expect(second.result.stdout).toBe("kept\n");
    expect(second.state).toBe("unchanged");

    const empty = await runtime.exec(
      { ...request, script: "true" } as never,
      null,
    );
    expect(empty.state).toBe("unchanged");
  });
});
