import { afterEach, expect, test } from "bun:test";
import { hostname } from "node:os";
import type { MachineExecFrame } from "../../../apps/core/src/shared/machine-socket.ts";
import { runExec, runMachineDaemon } from "../src/cli/machine.ts";
import { StageSessionRefusedError } from "../src/observability-client.ts";
import { startFakeCore } from "./fixtures/fake-core.ts";

const servers: Bun.Server<undefined>[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

test("runExec runs bash on this machine with the frame's cwd and env", async () => {
  const result = await runExec(
    exec({ code: "echo $GREETING $(hostname); pwd", env: { GREETING: "hi" } }),
    "/tmp",
  );

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain(`hi ${hostname()}`);
  expect(
    result.stdout.trim().endsWith("/tmp") ||
      result.stdout.includes("/private/tmp"),
  ).toBe(true);
  expect(result.timedOut).toBe(false);
});

test("runExec keeps the CLI's BROODS_ credentials out of the agent's shell", async () => {
  process.env.BROODS_API_KEY = "fp_agent_secret";
  try {
    const result = await runExec(
      exec({ code: 'echo "${BROODS_API_KEY:-unset} $HOME"' }),
      process.cwd(),
    );

    expect(result.stdout).toContain("unset");
    expect(result.stdout).not.toContain("fp_agent_secret");
    expect(result.stdout).toContain(process.env.HOME ?? "");
  } finally {
    delete process.env.BROODS_API_KEY;
  }
});

test("runExec kills a command at the timeout and says so", async () => {
  const result = await runExec(
    exec({ code: "sleep 5; echo late", timeoutSeconds: 1 }),
    process.cwd(),
  );

  expect(result.timedOut).toBe(true);
  expect(result.stdout).not.toContain("late");
  expect(result.durationMs).toBeLessThan(3_000);
});

test("runExec kills a running command when the socket lifetime aborts", async () => {
  const lifetime = new AbortController();
  const pending = runExec(
    exec({ code: "sleep 5; echo late", timeoutSeconds: 10 }),
    process.cwd(),
    lifetime.signal,
  );
  setTimeout(() => lifetime.abort(), 100);
  const result = await pending;

  expect(result.exitCode).toBeNull();
  expect(result.stderr).toContain("stopped: the daemon closed its socket");
  expect(result.stdout).not.toContain("late");
  expect(result.durationMs).toBeLessThan(2_000);
});

test("runExec cuts output at the limit and reports the exit code", async () => {
  const result = await runExec(
    exec({ code: "yes | head -c 5000; exit 3", outputLimitBytes: 100 }),
    process.cwd(),
  );

  expect(result.exitCode).toBe(3);
  expect(result.truncated).toBe(true);
  expect(result.stdout).toContain("[output truncated]");
  expect(result.stdout.length).toBeLessThan(200);
});

test("the daemon says hello, answers an exec, and stops on a refusal", async () => {
  const core = startFakeCore((frame) =>
    frame.type === "hello" ? exec({ code: "echo from-daemon" }) : null,
  );
  servers.push(core.server);
  const lines: string[] = [];

  await expect(
    runMachineDaemon({
      credential: async (): Promise<string> => "key",
      baseUrl: core.url,
      cwd: process.cwd(),
      log: (line: string): void => {
        lines.push(line);
      },
      sandbox: "my-mac",
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow("Replaced by a newer connection");

  expect(core.received[0]).toMatchObject({
    type: "hello",
    sandbox: "my-mac",
    hostname: hostname(),
  });
  expect(core.received[1]).toMatchObject({
    type: "result",
    stdout: "from-daemon\n",
  });
  expect(lines.slice(0, 2)).toEqual([
    "connected as my-mac (sbx_1)",
    "$ echo from-daemon",
  ]);
});

test("the daemon stops when the stage session is refused", async () => {
  await expect(
    runMachineDaemon({
      baseUrl: "http://127.0.0.1:9",
      credential: async (): Promise<string> => {
        throw new StageSessionRefusedError("Open stage session failed: 401");
      },
      cwd: process.cwd(),
      log: (): void => {},
      sandbox: "my-mac",
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow("Open stage session failed: 401");
});

test("the daemon retries when minting a stage session fails in transit", async () => {
  const core = startFakeCore((frame) =>
    frame.type === "hello" ? exec({ code: "true" }) : null,
  );
  servers.push(core.server);
  const lines: string[] = [];
  let calls = 0;

  await expect(
    runMachineDaemon({
      baseUrl: core.url,
      credential: async (): Promise<string> => {
        calls += 1;
        if (calls === 1) throw new Error("network down");

        return "key";
      },
      cwd: process.cwd(),
      log: (line: string): void => {
        lines.push(line);
      },
      sandbox: "my-mac",
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow("Replaced by a newer connection");

  expect(calls).toBe(2);
  expect(lines[0]).toStartWith("stage session unavailable (network down)");
});

function exec(overrides: Partial<MachineExecFrame>): MachineExecFrame {
  return {
    type: "exec",
    id: "exec-1",
    code: "true",
    timeoutSeconds: 10,
    outputLimitBytes: 64 * 1024,
    ...overrides,
  };
}
