import { afterEach, beforeEach, expect, test } from "bun:test";
import type { ToolExecuteFunction } from "ai";
import {
  callMcpTool,
  listMcpTools,
  mcpConnection,
} from "../src/harness/mcp/client.ts";
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
  MACHINE_CLOSE,
  MACHINE_WEBSOCKET_PATH,
  occupiedReason,
  parseCoreFrame,
  parseDaemonFrame,
  type MachineComputerFrame,
  type MachineExecFrame,
  type MachineMcpCallFrame,
  type MachineMcpListFrame,
  type MachineReadyFrame,
  type MachineResultFrame,
} from "../src/shared/machine-socket.ts";
import {
  resetStorageForTests,
  setStorageForTests,
} from "../src/shared/storage.ts";
import type { ResolvedAgentSandbox } from "../src/shared/workspaces.ts";
import {
  closeOf,
  MACHINE_ACCOUNT_ID,
  MACHINE_READ_ONLY_ROLE_TOKEN,
  MACHINE_RUNTIME_KEY,
  MACHINE_SANDBOX_ID,
  machineExecutorConfig,
  machineMcpRecord,
  machineStorage,
  otherMachineExecutorConfig,
  startMachineCore,
  waitFor,
  type MachineConnectionWrite,
} from "./helpers/machine.ts";

const servers: Bun.Server<MachineSocketData>[] = [];
const sockets: WebSocket[] = [];

/** What a fake daemon says in its hello, and how it answers. */
interface FakeDaemon {
  force?: boolean;
  hostname?: string;
  instance?: string;
  mcp?: string[];
  onComputer?: (frame: MachineComputerFrame, socket: WebSocket) => void;
  onMcp?: (
    frame: MachineMcpCallFrame | MachineMcpListFrame,
    socket: WebSocket,
  ) => void;
}

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

test("a daemon reconnecting reclaims its record, and a dropped daemon fails its in-flight run", async () => {
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

test("another daemon is refused naming the holder, even on the same host, and --force takes over", async () => {
  const server = core();
  const holder = await connectDaemon(server, "my-mac", () => {}, {
    hostname: "phicks-mac",
  });
  const hello = (extra: Record<string, unknown>): string =>
    JSON.stringify({ type: "hello", sandbox: "my-mac", ...extra });

  // A second daemon on the holder's own computer is the case a hostname check
  // would have let through.
  const local = openSocket(server);
  local.onopen = (): void =>
    local.send(hello({ hostname: "phicks-mac", instance: "second-daemon" }));
  const refused = await closeOf(local);

  expect(refused.code).toBe(MACHINE_CLOSE.occupied.code);
  expect(refused.reason).toBe(occupiedReason("phicks-mac"));

  // No instance is not the same daemon.
  const anonymous = openSocket(server);
  anonymous.onopen = (): void => anonymous.send(hello({}));

  expect((await closeOf(anonymous)).code).toBe(MACHINE_CLOSE.occupied.code);

  const holderClosed = closeOf(holder.socket);
  await connectDaemon(server, "my-mac", () => {}, {
    force: true,
    hostname: "kien-mac",
    instance: "second-daemon",
  });

  expect((await holderClosed).code).toBe(MACHINE_CLOSE.replaced.code);
});

test("a role session without sandboxes:write cannot claim a machine", async () => {
  const server = core();
  const readOnly = openSocket(server, MACHINE_READ_ONLY_ROLE_TOKEN);
  readOnly.onopen = (): void =>
    readOnly.send(JSON.stringify({ type: "hello", sandbox: "my-mac" }));

  expect((await closeOf(readOnly)).code).toBe(
    MACHINE_CLOSE.unknownSandbox.code,
  );
  // The runtime key the daemon is documented to use still claims it.
  const daemon = await connectDaemon(server, "my-mac", () => {});
  expect(daemon.ready.sandboxId).toBe(MACHINE_SANDBOX_ID);
});

test("the refusal reason fits a close frame however long the holder's host is", () => {
  const reason = occupiedReason("ü".repeat(80));

  // 123 bytes is the WebSocket cap; over it, or cut mid-character, the daemon
  // sees 1007 instead of 4423.
  expect(new TextEncoder().encode(reason).length).toBeLessThanOrEqual(123);
  expect(reason).toEndWith("pass --force to take it over");
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

  await connectDaemon(server, "my-mac", () => {}, {
    onComputer: (frame, socket) => {
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
  });
  const execute = computerTool([machine()]).computer
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

test("with two computers attached, a call reaches the one it names", async () => {
  const server = core();
  await connectDaemon(server, "my-mac", () => {}, {
    onComputer: answersWith("mine"),
  });
  await connectDaemon(server, "other-mac", () => {}, {
    onComputer: answersWith("theirs"),
  });
  const execute = computerTool([machine(), machine("other-mac", "bypass")])
    .computer?.execute as ToolExecuteFunction<
    Record<string, unknown>,
    unknown,
    Record<string, unknown>
  >;
  const options = { toolCallId: "call-1", messages: [], context: {} };

  expect(
    await execute({ action: "cursor_position", sandbox: "other-mac" }, options),
  ).toEqual({ type: "text", value: "theirs on other-mac" });
  expect(
    await execute({ action: "cursor_position", sandbox: "my-mac" }, options),
  ).toEqual({ type: "text", value: "mine on my-mac" });
  // Two screens and no name is ambiguous, so it is refused rather than guessed.
  await expect(execute({ action: "cursor_position" }, options)).rejects.toThrow(
    "pass sandbox with the computer to act on: my-mac, other-mac",
  );
});

test("a name from a longer list is refused once one computer is left", async () => {
  const server = core();
  await connectDaemon(server, "my-mac", () => {}, {
    onComputer: answersWith("mine"),
  });
  const execute = computerTool([machine()]).computer
    ?.execute as ToolExecuteFunction<
    Record<string, unknown>,
    unknown,
    Record<string, unknown>
  >;
  const options = { toolCallId: "call-1", messages: [], context: {} };

  // An approval replayed after the agent lost a machine still carries the name it
  // was granted for. That must not land on the machine that is left.
  await expect(
    execute({ action: "cursor_position", sandbox: "other-mac" }, options),
  ).rejects.toThrow("pass sandbox with the computer to act on: my-mac");
  expect(await execute({ action: "cursor_position" }, options)).toEqual({
    type: "text",
    value: "mine",
  });
});

test("an MCP row lists and calls through the daemon that serves that server", async () => {
  const server = core();
  const connection = mcpConnection(machineMcpRecord(), undefined);

  await expect(listMcpTools(connection)).rejects.toThrow("is not connected");
  await connectDaemon(server, "my-mac", () => {}, { mcp: ["other"] });
  await expect(listMcpTools(connection)).rejects.toThrow(
    'does not serve MCP server "echo"',
  );

  await connectDaemon(server, "my-mac", () => {}, {
    mcp: ["echo"],
    onMcp: (frame, socket) => {
      socket.send(
        JSON.stringify(
          frame.type === "mcp-list"
            ? {
                type: "mcp-tools",
                id: frame.id,
                tools: [{ name: "echo", inputSchema: { type: "object" } }],
              }
            : {
                type: "mcp-result",
                id: frame.id,
                result: {
                  content: [{ type: "text", text: `echo: ${frame.args.text}` }],
                },
              },
        ),
      );
    },
  });

  expect((await listMcpTools(connection)).map((tool) => tool.name)).toEqual([
    "echo",
  ]);
  expect(await callMcpTool(connection, "echo", { text: "pong" })).toBe(
    "echo: pong",
  );
});

test("core records each daemon connection, and a disconnect names that same connection", async () => {
  const writes: MachineConnectionWrite[] = [];
  setStorageForTests(machineStorage(writes));
  const server = core();
  await connectDaemon(server, "my-mac", () => {}, { mcp: ["echo"] });
  const replacement = await connectDaemon(server, "my-mac", () => {});
  // An earlier test's socket can still close into `writes`, so match by id.
  const connects = (): MachineConnectionWrite[] =>
    writes.filter((write) => write.kind === "connected");
  const disconnected = (connectionId: string | undefined): boolean =>
    writes.some(
      (write) =>
        write.kind === "disconnected" &&
        write.ref.connectionId === connectionId,
    );
  await waitFor(() => connects().length === 2);
  const [first, second] = connects();
  replacement.socket.close();
  await waitFor(() => disconnected(second?.ref.connectionId));

  expect(first?.ref).toMatchObject({
    accountId: MACHINE_ACCOUNT_ID,
    sandboxConfigId: MACHINE_SANDBOX_ID,
    computer: false,
    mcp: ["echo"],
  });
  expect(second?.ref.connectionId).not.toBe(first?.ref.connectionId);
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
        sandboxes: [
          {
            name: "my-mac",
            sandbox: { ...machineExecutorConfig(), permissionMode: mode },
          },
        ],
      },
    );

  expect(approval("screenshot", "ask")).toBeUndefined();
  expect(approval("zoom", "edit")).toBeUndefined();
  expect(approval("left_click", "ask")).toBe("user-approval");
  expect(approval("type", "edit")).toBe("user-approval");
  expect(approval("type", "bypass")).toBeUndefined();
});

test("approval follows the computer a call names, not the agent's own", () => {
  const approval = (
    sandbox?: string,
  ): ReturnType<typeof compatibilityApprovalStatus> =>
    compatibilityApprovalStatus(
      "computer",
      { action: "type", ...(sandbox ? { sandbox: sandbox } : {}) },
      {
        configuredApprovals: new Map(),
        workspaces: [],
        sandboxes: [
          {
            name: "my-mac",
            sandbox: { ...machineExecutorConfig(), permissionMode: "ask" },
          },
          {
            name: "other-mac",
            sandbox: { provider: "machine", permissionMode: "bypass" },
          },
        ],
      },
    );

  expect(approval("my-mac")).toBe("user-approval");
  expect(approval("other-mac")).toBeUndefined();
  // Naming none, or naming one that is not attached, cannot silently land on the
  // machine that happens to be `bypass`.
  expect(approval()).toBe("user-approval");
  expect(approval("nope")).toBe("user-approval");
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
  expect(
    parseCoreFrame('{"type":"mcp-call","id":"1","server":"echo","tool":"t"}'),
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

/** A fake daemon that answers every computer frame with one fixed text. */
function answersWith(text: string): NonNullable<FakeDaemon["onComputer"]> {
  return (frame, socket): void => {
    socket.send(
      JSON.stringify({ type: "computer-result", id: frame.id, text: text }),
    );
  };
}

function connectDaemon(
  server: Bun.Server<MachineSocketData>,
  sandbox: string,
  onExec: (frame: MachineExecFrame, socket: WebSocket) => void,
  daemon: FakeDaemon = {},
): Promise<{ ready: MachineReadyFrame; socket: WebSocket }> {
  return new Promise((resolve, reject): void => {
    const socket = openSocket(server);
    let ready = false;
    socket.onopen = (): void =>
      socket.send(
        JSON.stringify({
          type: "hello",
          sandbox: sandbox,
          hostname: daemon.hostname ?? "test-host",
          computer: daemon.onComputer !== undefined,
          mcp: daemon.mcp,
          // One shared instance, so a fake connecting twice is a reconnect.
          instance: daemon.instance ?? "test-daemon",
          force: daemon.force,
        }),
      );
    socket.onmessage = (event): void => {
      const frame = parseCoreFrame(event.data);
      if (frame?.type === "ready") {
        ready = true;
        resolve({ ready: frame, socket: socket });
      }
      if (frame?.type === "exec") onExec(frame, socket);
      if (frame?.type === "computer") daemon.onComputer?.(frame, socket);
      if (frame?.type === "mcp-call" || frame?.type === "mcp-list") {
        daemon.onMcp?.(frame, socket);
      }
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

/** One of the two machine records, as the computer tool sees it. */
function machine(
  name: "my-mac" | "other-mac" = "my-mac",
  permissionMode: SandboxPermissionMode = "ask",
): ResolvedAgentSandbox {
  const sandbox =
    name === "my-mac" ? machineExecutorConfig() : otherMachineExecutorConfig();

  return {
    name: name,
    sandbox: { ...sandbox, permissionMode: permissionMode },
  };
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
