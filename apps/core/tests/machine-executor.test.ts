import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  MachineSandboxExecutor,
  isMachineUpgrade,
  type MachineSocketData,
} from "../src/harness/sandbox/machine-executor.ts";
import {
  MACHINE_WEBSOCKET_PATH,
  parseCoreFrame,
  parseDaemonFrame,
  type MachineExecFrame,
  type MachineReadyFrame,
  type MachineResultFrame,
} from "../src/shared/machine-socket.ts";
import {
  resetStorageForTests,
  setStorageForTests,
} from "../src/shared/storage.ts";
import {
  MACHINE_RUNTIME_KEY,
  MACHINE_SANDBOX_ID,
  machineExecutorConfig,
  machineStorage,
  startMachineCore,
} from "./helpers/machine.ts";

/**
 * Core's half of the machine sandbox: the daemon socket claims a record, the
 * executor turns `run` into an exec frame on that socket, and a missing,
 * refused or replaced daemon fails with a reason the model can act on.
 */

const servers: Bun.Server<MachineSocketData>[] = [];
const sockets: WebSocket[] = [];

beforeEach(() => {
  setStorageForTests(machineStorage());
});

afterEach(() => {
  for (const socket of sockets.splice(0)) socket.close();
  for (const server of servers.splice(0)) server.stop(true);
  resetStorageForTests();
});

test("a run round-trips through the daemon socket that claimed the record", async () => {
  const daemon = await connectDaemon(core(), "my-mac", (frame, socket) => {
    socket.send(
      JSON.stringify(
        result(frame.id, {
          stdout: `ran: ${frame.code} in ${frame.cwd} as ${frame.env?.WHO}`,
          durationMs: 7,
        }),
      ),
    );
  });
  expect(daemon.ready.sandboxId).toBe(MACHINE_SANDBOX_ID);

  const outcome = await new MachineSandboxExecutor(
    machineExecutorConfig({
      options: { cwd: "/Users/me/app" },
      envVars: { WHO: "me" },
    }),
  ).run({ code: "echo hi", timeoutSeconds: 5, outputLimitBytes: 1024 });

  expect(outcome).toMatchObject({
    ok: true,
    exitCode: 0,
    stdout: "ran: echo hi in /Users/me/app as me",
    durationMs: 7,
    provider: "machine",
  });
});

test("a run with no daemon connected names the command to fix it", async () => {
  core();

  await expect(
    new MachineSandboxExecutor(machineExecutorConfig()).run({
      code: "true",
      timeoutSeconds: 5,
      outputLimitBytes: 1024,
    }),
  ).rejects.toThrow(
    'machine sandbox "my-mac" is not connected. Run `broods machine my-mac`',
  );
});

test("a second daemon replaces the first, and a dropped daemon fails its in-flight run", async () => {
  const server = core();
  const first = await connectDaemon(server, "my-mac", () => {});
  const firstClosed = closeOf(first.socket);
  // Settled by the replacement before this test can await it, so the handler
  // is attached up front.
  const pending = new MachineSandboxExecutor(machineExecutorConfig())
    .run({ code: "sleep 1", timeoutSeconds: 5, outputLimitBytes: 1024 })
    .then(
      () => "resolved",
      (error: Error) => error.message,
    );

  await connectDaemon(server, "my-mac", () => {});

  expect((await firstClosed).code).toBe(4409);
  expect(await pending).toBe("Replaced by a newer connection");
});

test("an unknown record or a wrong provider closes the socket with 4404", async () => {
  const socket = openSocket(core());
  socket.onopen = (): void =>
    socket.send(JSON.stringify({ type: "hello", sandbox: "cloud-box" }));

  expect((await closeOf(socket)).code).toBe(4404);
});

test("a bad bearer still upgrades, and its first frame is refused with 4401", async () => {
  expect(
    isMachineUpgrade(
      new Request(`http://x${MACHINE_WEBSOCKET_PATH}`, {
        headers: { upgrade: "websocket" },
      }),
    ),
  ).toBe(true);
  expect(isMachineUpgrade(new Request("http://x/v1/runs"))).toBe(false);

  const socket = openSocket(core(), "nope");
  socket.onopen = (): void =>
    socket.send(JSON.stringify({ type: "hello", sandbox: "my-mac" }));

  expect((await closeOf(socket)).code).toBe(4401);
});

test("a result with missing fields is a bad frame, and so is a second hello", async () => {
  const server = core();
  const first = await connectDaemon(server, "my-mac", (frame, socket) => {
    socket.send(JSON.stringify({ type: "result", id: frame.id }));
  });
  const firstClosed = closeOf(first.socket);

  await expect(
    new MachineSandboxExecutor(machineExecutorConfig()).run({
      code: "true",
      timeoutSeconds: 5,
      outputLimitBytes: 1024,
    }),
  ).rejects.toThrow("disconnected while the command was running");
  expect((await firstClosed).code).toBe(4400);

  const second = await connectDaemon(server, "my-mac", () => {});
  const secondClosed = closeOf(second.socket);
  second.socket.send(JSON.stringify({ type: "hello", sandbox: "my-mac" }));

  expect((await secondClosed).code).toBe(4400);
});

test("each side's parser drops a frame whose fields do not match its type", () => {
  expect(parseCoreFrame('{"type":"exec","id":"1","code":"yes"}')).toBeNull();
  expect(
    parseCoreFrame(
      '{"type":"exec","id":"1","code":"yes","timeoutSeconds":0,"outputLimitBytes":10}',
    ),
  ).toBeNull();
  expect(parseCoreFrame('{"type":"ready"}')).toBeNull();
  expect(parseCoreFrame('{"type":"hello","sandbox":"my-mac"}')).toBeNull();
  expect(parseDaemonFrame('{"type":"hello","sandbox":""}')).toBeNull();
  expect(
    parseDaemonFrame(
      '{"type":"result","id":"1","exitCode":0,"stdout":"","stderr":"","durationMs":1}',
    ),
  ).toBeNull();
  expect(parseDaemonFrame("[]")).toBeNull();
  expect(parseDaemonFrame("nope")).toBeNull();
  expect(
    parseCoreFrame(
      '{"type":"exec","id":"1","code":"yes","timeoutSeconds":5,"outputLimitBytes":10,"env":{"A":"b"},"extra":1}',
    ),
  ).toEqual({
    type: "exec",
    id: "1",
    code: "yes",
    env: { A: "b" },
    timeoutSeconds: 5,
    outputLimitBytes: 10,
  });
});

function closeOf(socket: WebSocket): Promise<CloseEvent> {
  return new Promise((resolve): void => {
    socket.onclose = resolve;
  });
}

function connectDaemon(
  server: Bun.Server<MachineSocketData>,
  sandbox: string,
  onExec: (frame: MachineExecFrame, socket: WebSocket) => void,
): Promise<{ ready: MachineReadyFrame; socket: WebSocket }> {
  return new Promise((resolve, reject): void => {
    const socket = openSocket(server);
    let ready = false;
    socket.onopen = (): void =>
      socket.send(JSON.stringify({ type: "hello", sandbox: sandbox }));
    socket.onmessage = (event): void => {
      const frame = parseCoreFrame(event.data);
      if (frame?.type === "ready") {
        ready = true;
        resolve({ ready: frame, socket: socket });
      }
      if (frame?.type === "exec") onExec(frame, socket);
    };
    socket.onclose = (event): void => {
      if (!ready) reject(new Error(`closed ${event.code} ${event.reason}`));
    };
  });
}

function core(): Bun.Server<MachineSocketData> {
  const server = startMachineCore();
  servers.push(server);

  return server;
}

function openSocket(
  server: Bun.Server<MachineSocketData>,
  token: string = MACHINE_RUNTIME_KEY,
): WebSocket {
  const socket = new WebSocket(
    `ws://127.0.0.1:${server.port}${MACHINE_WEBSOCKET_PATH}`,
    { headers: { authorization: `Bearer ${token}` } } as unknown as string[],
  );
  sockets.push(socket);

  return socket;
}

function result(
  id: string,
  overrides: Partial<MachineResultFrame>,
): MachineResultFrame {
  return {
    type: "result",
    id: id,
    exitCode: 0,
    stdout: "",
    stderr: "",
    durationMs: 1,
    timedOut: false,
    truncated: false,
    ...overrides,
  };
}
