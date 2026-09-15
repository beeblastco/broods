import { afterEach, beforeEach, expect, test } from "bun:test";
import type { ToolExecuteFunction } from "ai";
import { compatibilityApprovalStatus } from "../src/harness/policy.ts";
import {
  MachineSandboxExecutor,
  isMachineUpgrade,
  runMachineComputerAction,
  type MachineSocketData,
} from "../src/harness/sandbox/machine-executor.ts";
import computerTool from "../src/harness/tools/computer.tool.ts";
import type { SandboxPermissionMode } from "../src/shared/domain/sandbox-config.ts";
import {
  MACHINE_WEBSOCKET_PATH,
  parseCoreFrame,
  parseDaemonFrame,
  type MachineComputerFrame,
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
  // The replacement rejects this run before the next await.
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

test("the computer tool reaches a daemon started with --computer, and names the flag otherwise", async () => {
  const server = core();
  await connectDaemon(server, "my-mac", () => {});
  await expect(
    runMachineComputerAction(machineExecutorConfig(), { action: "screenshot" }),
  ).rejects.toThrow("broods machine my-mac --computer");

  await connectDaemon(
    server,
    "my-mac",
    () => {},
    (frame, socket) => {
      socket.send(
        JSON.stringify({
          type: "computer-result",
          id: frame.id,
          ...(frame.action === "screenshot"
            ? { image: { data: "AAAA", mediaType: "image/png" } }
            : {
                text: `X=${frame.coordinate?.[0]},Y=${frame.coordinate?.[1]}`,
              }),
          app: "com.apple.Safari",
        }),
      );
    },
  );
  const execute = computerTool(machineExecutorConfig()).computer
    ?.execute as ToolExecuteFunction<
    Record<string, unknown>,
    unknown,
    Record<string, unknown>
  >;
  const options = { toolCallId: "call-1", messages: [], context: {} };

  expect(await execute({ action: "screenshot" }, options)).toEqual({
    type: "content",
    value: [
      { type: "text", text: "Screenshot (frontmost app: com.apple.Safari)" },
      { type: "image-data", data: "AAAA", mediaType: "image/png" },
    ],
  });
  expect(
    await execute({ action: "left_click", coordinate: [10, 20] }, options),
  ).toEqual({
    type: "text",
    value: "X=10,Y=20 (frontmost app: com.apple.Safari)",
  });
});

test("looking at the screen is free, anything else asks unless the sandbox is bypass", () => {
  const approval = (
    action: string,
    mode: SandboxPermissionMode,
  ): ReturnType<typeof compatibilityApprovalStatus> =>
    compatibilityApprovalStatus(
      "computer",
      { action: action },
      {
        configuredApprovals: new Map(),
        workspaces: [],
        agentSandbox: machineExecutorConfig(),
        agentSandboxPermissionMode: mode,
      },
    );

  expect(approval("screenshot", "ask")).toBeUndefined();
  expect(approval("zoom", "edit")).toBeUndefined();
  expect(approval("left_click", "ask")).toBe("user-approval");
  expect(approval("type", "edit")).toBe("user-approval");
  expect(approval("type", "bypass")).toBeUndefined();
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
  expect(
    parseCoreFrame('{"type":"computer","id":"1","action":"fly"}'),
  ).toBeNull();
  expect(
    parseCoreFrame(
      '{"type":"computer","id":"1","action":"left_click","coordinate":[1]}',
    ),
  ).toBeNull();
  expect(parseDaemonFrame('{"type":"hello","sandbox":""}')).toBeNull();
  expect(
    parseDaemonFrame(
      '{"type":"result","id":"1","exitCode":0,"stdout":"","stderr":"","durationMs":1}',
    ),
  ).toBeNull();
  expect(
    parseDaemonFrame('{"type":"computer-result","id":"1","image":"AAAA"}'),
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
  expect(
    parseCoreFrame(
      '{"type":"computer","id":"1","action":"zoom","region":[0,0,10,10]}',
    ),
  ).toEqual({
    type: "computer",
    id: "1",
    action: "zoom",
    region: [0, 0, 10, 10],
  });
});

function closeOf(socket: WebSocket): Promise<CloseEvent> {
  return new Promise((resolve): void => {
    socket.onclose = resolve;
  });
}

/** Passing `onComputer` makes the daemon say it started with --computer. */
function connectDaemon(
  server: Bun.Server<MachineSocketData>,
  sandbox: string,
  onExec: (frame: MachineExecFrame, socket: WebSocket) => void,
  onComputer?: (frame: MachineComputerFrame, socket: WebSocket) => void,
): Promise<{ ready: MachineReadyFrame; socket: WebSocket }> {
  return new Promise((resolve, reject): void => {
    const socket = openSocket(server);
    let ready = false;
    socket.onopen = (): void =>
      socket.send(
        JSON.stringify({
          type: "hello",
          sandbox: sandbox,
          computer: onComputer !== undefined,
        }),
      );
    socket.onmessage = (event): void => {
      const frame = parseCoreFrame(event.data);
      if (frame?.type === "ready") {
        ready = true;
        resolve({ ready: frame, socket: socket });
      }
      if (frame?.type === "exec") onExec(frame, socket);
      if (frame?.type === "computer") onComputer?.(frame, socket);
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
