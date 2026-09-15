import { afterEach, expect, test } from "bun:test";
import { hostname } from "node:os";
import type { MachineExecFrame } from "../../../apps/core/src/shared/machine-socket.ts";
import { runExec, runMachineDaemon } from "../src/cli/machine.ts";
import { startFakeCore } from "./fixtures/fake-core.ts";

/**
 * The daemon is the half of the machine sandbox that runs on the user's
 * computer, so these run real bash here: a command must come back with this
 * host's output, a runaway must be killed at the timeout, and output past the
 * limit must be cut, not buffered.
 */

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
      apiKey: "key",
      baseUrl: core.url,
      cwd: process.cwd(),
      log: (line) => lines.push(line),
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
