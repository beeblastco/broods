import { afterEach, expect, test } from "bun:test";
import { hostname } from "node:os";
import { runExec, runMachineDaemon } from "../src/cli/machine.ts";
import type {
  MachineExecFrame,
  MachineResultFrame,
} from "../src/machine-contracts.ts";

/**
 * The daemon is the half of the machine sandbox that runs on the user's
 * computer, so these run real bash here: a command must come back with this
 * host's output, a runaway must be killed at the timeout, and output past the
 * limit must be cut, not buffered.
 */

const servers: Bun.Server<unknown>[] = [];

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
  expect(result.timedOut).toBeUndefined();
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

test("the daemon says hello, answers an exec, and stops on a fatal close", async () => {
  const seen: { hello?: unknown; result?: MachineResultFrame } = {};
  const server = Bun.serve<{ id: string }>({
    port: 0,
    fetch: (request, bunServer) =>
      bunServer.upgrade(request, { data: { id: "1" } })
        ? undefined
        : new Response("no", { status: 400 }),
    websocket: {
      message: function (socket, raw): void {
        const frame = JSON.parse(String(raw)) as { type: string };
        if (frame.type === "hello") {
          seen.hello = frame;
          socket.send(JSON.stringify({ type: "ready", sandboxId: "sbx_1" }));
          socket.send(JSON.stringify(exec({ code: "echo from-daemon" })));

          return;
        }
        seen.result = frame as MachineResultFrame;
        socket.close(4409, "Replaced by a newer connection");
      },
    },
  });
  servers.push(server);
  const lines: string[] = [];

  await expect(
    runMachineDaemon({
      apiKey: "key",
      baseUrl: `http://127.0.0.1:${server.port}`,
      cwd: process.cwd(),
      log: (line) => lines.push(line),
      sandbox: "my-mac",
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow("Replaced by a newer connection");

  expect(seen.hello).toMatchObject({
    type: "hello",
    sandbox: "my-mac",
    hostname: hostname(),
  });
  expect(seen.result?.stdout).toBe("from-daemon\n");
  expect(lines[0]).toBe("connected as my-mac (sbx_1)");
  expect(lines[1]).toBe("$ echo from-daemon");
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
