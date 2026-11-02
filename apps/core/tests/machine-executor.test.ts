import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { sealStageSessionTicket } from "@broods/convex/model/stageSessionTicket";
import {
  simulateReadableStream,
  streamText,
  tool,
  type ModelMessage,
  type ToolApprovalRequestOutput,
  type ToolApprovalResponse,
  type ToolApprovalStatus,
  type ToolExecuteFunction,
  type ToolSet,
} from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import {
  callMcpTool,
  listMcpTools,
  mcpConnection,
} from "../src/harness/mcp/client.ts";
import {
  compatibilityApprovalStatus,
  createRuntimeToolApproval,
} from "../src/harness/policy.ts";
import {
  MachineSandboxExecutor,
  isMachineUpgrade,
  runMachineComputerAction,
  type MachineSocketData,
} from "../src/harness/sandbox/machine-executor.ts";
import {
  serializeToolCalls,
  type ToolExecute,
} from "../src/harness/tool-execute.ts";
import computerTool from "../src/harness/tools/computer.tool.ts";
import type { SandboxPermissionMode } from "../src/shared/domain/sandbox-config.ts";
import {
  MACHINE_CLOSE,
  MACHINE_WEBSOCKET_PATH,
  occupiedReason,
  parseCoreFrame,
  parseDaemonFrame,
  type ComputerInput,
  type MachineComputerFrame,
  type MachineExecFrame,
  type MachineHelloFrame,
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
  DEV_STAGE_SANDBOX_ID,
  MACHINE_ACCOUNT_ID,
  MACHINE_READ_ONLY_ROLE_TOKEN,
  MACHINE_ACCOUNT_SECRET,
  MACHINE_EMBEDDABLE_KEY,
  MACHINE_SANDBOX_ID,
  machineExecutorConfig,
  machineMcpRecord,
  machineStorage,
  otherMachineExecutorConfig,
  PROD_STAGE_SANDBOX_ID,
  startMachineCore,
  waitFor,
  type MachineConnectionWrite,
} from "./helpers/machine.ts";

const servers: Bun.Server<MachineSocketData>[] = [];
const sockets: WebSocket[] = [];

/** What a fake daemon says in its hello, and how it answers. */
interface FakeDaemon {
  force?: boolean;
  /** The bearer it connects with; the account key when unset. */
  token?: string;
  hostname?: string;
  instance?: string;
  mcp?: string[];
  specs?: MachineHelloFrame["specs"];
  onComputer?: (frame: MachineComputerFrame, socket: WebSocket) => void;
  onMcp?: (
    frame: MachineMcpCallFrame | MachineMcpListFrame,
    socket: WebSocket,
  ) => void;
}

beforeEach(() => {
  setStorageForTests(machineStorage());
});

afterEach(async (): Promise<void> => {
  for (const socket of sockets.splice(0)) socket.close();
  for (const server of servers.splice(0)) await server.stop(true);
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

  expect(
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

test("a daemon that hangs up while its claim is looked up leaves the record free", async () => {
  const storage = machineStorage();
  const list = storage.sandboxConfigs.list.bind(storage.sandboxConfigs);
  let release: () => void = () => {};
  const held = new Promise<void>((resolve): void => {
    release = resolve;
  });
  let looking: () => void = () => {};
  const lookedUp = new Promise<void>((resolve): void => {
    looking = resolve;
  });
  storage.sandboxConfigs.list = async (accountId: string) => {
    looking();
    await held;

    return await list(accountId);
  };
  setStorageForTests(storage);
  const server = core();

  const gone = openSocket(server);
  gone.onopen = (): void =>
    gone.send(
      JSON.stringify({ type: "hello", sandbox: "my-mac", instance: "gone" }),
    );
  await lookedUp;
  gone.close();
  await closeOf(gone);
  // Let core run its close handler before the lookup answers.
  await new Promise((resolve) => setTimeout(resolve, 50));
  storage.sandboxConfigs.list = list;
  release();

  // Another daemon, with no --force, gets the record the dead socket never held.
  const next = await connectDaemon(server, "my-mac", () => {}, {
    instance: "next",
  });
  expect(next.ready.sandboxId).toBe(MACHINE_SANDBOX_ID);
});

test("another daemon is refused naming the holder, even on the same host, and --force takes over", async () => {
  const server = core();
  const holder = await connectDaemon(server, "my-mac", () => {}, {
    hostname: "office-mac",
  });
  const hello = (extra: Record<string, unknown>): string =>
    JSON.stringify({ type: "hello", sandbox: "my-mac", ...extra });

  // A second daemon on the holder's own computer is the case a hostname check
  // would have let through.
  const local = openSocket(server);
  local.onopen = (): void =>
    local.send(hello({ hostname: "office-mac", instance: "second-daemon" }));
  const refused = await closeOf(local);

  expect(refused.code).toBe(MACHINE_CLOSE.occupied.code);
  expect(refused.reason).toBe(occupiedReason("office-mac"));

  // No instance is not the same daemon.
  const anonymous = openSocket(server);
  anonymous.onopen = (): void => anonymous.send(hello({}));

  expect((await closeOf(anonymous)).code).toBe(MACHINE_CLOSE.occupied.code);

  const holderClosed = closeOf(holder.socket);
  await connectDaemon(server, "my-mac", () => {}, {
    force: true,
    hostname: "laptop-mac",
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

test("the embeddable runtime key cannot claim a machine", async () => {
  const socket = openSocket(core(), MACHINE_EMBEDDABLE_KEY);
  socket.onopen = (): void =>
    socket.send(
      JSON.stringify({ type: "hello", sandbox: "my-mac", force: true }),
    );

  expect((await closeOf(socket)).code).toBe(4401);
});

describe("a stage ticket", () => {
  let previousSecret: string | undefined;

  beforeEach(() => {
    previousSecret = process.env.STAGE_TICKET_SECRET;
    process.env.STAGE_TICKET_SECRET = "stage-secret";
  });

  afterEach(() => {
    if (previousSecret === undefined) delete process.env.STAGE_TICKET_SECRET;
    else process.env.STAGE_TICKET_SECRET = previousSecret;
  });

  const ticket = (stageId: string, sandboxWrite: boolean): Promise<string> =>
    sealStageSessionTicket(
      {
        accountId: MACHINE_ACCOUNT_ID,
        endpointId: "endpoint",
        projectId: "proj",
        projectSlug: "demo",
        stageId: stageId,
        stageSlug: stageId === "stage_dev" ? "development" : "production",
        ...(sandboxWrite ? { sandboxWrite: true as const } : {}),
        expiresAt: Date.now() + 60_000,
      },
      "stage-secret",
    );

  test("minted in the dashboard by any member cannot claim a machine", async () => {
    const socket = openSocket(core(), await ticket("stage_prod", false));
    socket.onopen = (): void =>
      socket.send(
        JSON.stringify({ type: "hello", sandbox: "prod-mac", force: true }),
      );

    expect((await closeOf(socket)).code).toBe(MACHINE_CLOSE.unauthorized.code);
  });

  test("from broods login claims its own stage's record, never another stage's", async () => {
    const server = core();
    const devTicket = await ticket("stage_dev", true);
    const dev = await connectDaemon(server, "stage-mac", () => {}, {
      token: devTicket,
    });

    expect(dev.ready.sandboxId).toBe(DEV_STAGE_SANDBOX_ID);

    const other = openSocket(server, devTicket);
    other.onopen = (): void =>
      other.send(
        JSON.stringify({ type: "hello", sandbox: "prod-mac", force: true }),
      );
    expect((await closeOf(other)).code).toBe(MACHINE_CLOSE.unknownSandbox.code);

    const prod = await connectDaemon(server, "stage-mac", () => {}, {
      token: await ticket("stage_prod", true),
      instance: "prod-daemon",
    });
    expect(prod.ready.sandboxId).toBe(PROD_STAGE_SANDBOX_ID);
  });

  test("from broods login still claims an account-level record", async () => {
    const daemon = await connectDaemon(core(), "my-mac", () => {}, {
      token: await ticket("stage_dev", true),
    });

    expect(daemon.ready.sandboxId).toBe(MACHINE_SANDBOX_ID);
  });
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

  expect(
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
  expect(
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
  expect(execute({ action: "cursor_position" }, options)).rejects.toThrow(
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
  expect(
    execute({ action: "cursor_position", sandbox: "other-mac" }, options),
  ).rejects.toThrow("pass sandbox with the computer to act on: my-mac");
  expect(await execute({ action: "cursor_position" }, options)).toEqual({
    type: "text",
    value: "mine",
  });
});

test("one step's computer actions reach the daemon one at a time, in the model's order", async () => {
  const server = core();
  const sent: string[] = [];
  let inFlight = 0;
  let overlapped = false;
  await connectDaemon(server, "my-mac", () => {}, {
    onComputer: (frame, socket): void => {
      sent.push(frame.action);
      overlapped ||= inFlight > 0;
      inFlight += 1;
      setTimeout((): void => {
        inFlight -= 1;
        answersWith("OK")(frame, socket);
      }, 10);
    },
  });
  const { tools, reserve } = serializeToolCalls(
    computerTool([machine()]),
    "computer",
  );
  const actions: ComputerInput[] = [
    { action: "left_click", coordinate: [10, 20] },
    { action: "type", text: "hello" },
    { action: "screenshot" },
  ];

  await streamText({
    model: computerStepModel(actions),
    prompt: "type hello into the field",
    tools: tools,
    // Like the harness: reserve first, then await. The click's start (a
    // lifecycle webhook) resolves last, as in the trace where the text was
    // typed before the click that focused the field.
    onToolExecutionStart: async ({ toolCall }): Promise<void> => {
      reserve(toolCall);
      if (toolCall.toolCallId === "call-0") await Bun.sleep(50);
    },
  }).consumeStream();

  expect(sent).toEqual(["left_click", "type", "screenshot"]);
  expect(overlapped).toBe(false);
});

test("a stopped run drops queued computer actions without waiting for the running one", async () => {
  const click = Promise.withResolvers<void>();
  const ran: string[] = [];
  const { tools, reserve } = serializeToolCalls(
    recordingComputer(ran, click.promise),
    "computer",
  );
  const execute = tools.computer?.execute;
  const controller = new AbortController();
  const options = (toolCallId: string): Parameters<ToolExecute>[1] => ({
    toolCallId: toolCallId,
    messages: [],
    abortSignal: controller.signal,
    context: undefined,
  });
  reserve({ toolName: "computer", toolCallId: "click" });
  reserve({ toolName: "computer", toolCallId: "type" });
  const clicked = Promise.resolve(
    execute?.({ action: "left_click" }, options("click")),
  );
  const typed = Promise.resolve(execute?.({ action: "type" }, options("type")));
  await Bun.sleep(1);

  controller.abort();
  const outcome = await Promise.race([
    typed.then(
      (): string => "ran",
      (): string => "dropped",
    ),
    Bun.sleep(50).then((): string => "still waiting"),
  ]);
  click.resolve();
  await clicked;

  expect(outcome).toBe("dropped");
  expect(ran).toEqual(["left_click"]);
});

test("a computer call the SDK never runs does not hold up the next one", async () => {
  const sent: string[] = [];
  const server = core();
  await connectDaemon(server, "my-mac", () => {}, {
    onComputer: (frame, socket): void => {
      sent.push(frame.action);
      answersWith("OK")(frame, socket);
    },
  });
  const { tools, reserve } = serializeToolCalls(
    computerTool([machine()]),
    "computer",
  );

  // call-0 is denied, call-1 is not valid input, so neither starts.
  await streamText({
    model: computerStepModel([
      { action: "left_click", coordinate: [10, 20] },
      { action: "dance" },
      { action: "screenshot" },
    ]),
    prompt: "look at the screen",
    tools: tools,
    toolApproval: ({ toolCall }): "denied" | "approved" =>
      toolCall.toolCallId === "call-0" ? "denied" : "approved",
    onToolExecutionStart: ({ toolCall }): void => reserve(toolCall),
  }).consumeStream();

  expect(sent).toEqual(["screenshot"]);
});

test("in ask mode, a screenshot after a click waiting for approval waits with it and runs after it", async () => {
  const ran: string[] = [];
  const asked = await askedClickThenScreenshot(ran);

  expect(ran).toEqual([]);
  expect(
    asked.requests.map((request): [string, boolean] => [
      request.toolCall.toolCallId,
      request.isAutomatic === true,
    ]),
  ).toEqual([
    ["call-0", false],
    ["call-1", false],
  ]);

  await resumed(
    ran,
    asked,
    [true, true],
    [{ action: "screenshot" }],
  ).consumeStream();

  // The hold ends with its step: the next step's screenshot does not ask.
  expect(ran).toEqual(["left_click", "screenshot", "screenshot"]);
});

test("a denied click does not hold up the screenshot that waited with it", async () => {
  const ran: string[] = [];
  const asked = await askedClickThenScreenshot(ran);
  const outcome = await Promise.race([
    resumed(ran, asked, [false, true], [])
      .consumeStream()
      .then((): string => "settled"),
    Bun.sleep(500).then((): string => "hung"),
  ]);

  expect(outcome).toBe("settled");
  expect(ran).toEqual(["screenshot"]);
});

test("a stopped run drops the screenshot queued behind an approved click", async () => {
  const ran: string[] = [];
  const asked = await askedClickThenScreenshot(ran);
  const stop = new AbortController();
  const outcome = Promise.race([
    resumed(ran, asked, [true, true], [], stop)
      .consumeStream({ onError: (): void => {} })
      .then((): string => "settled"),
    Bun.sleep(500).then((): string => "hung"),
  ]);
  await waitFor((): boolean => ran.length > 0);
  stop.abort();

  expect(await outcome).toBe("settled");
  expect(ran).toEqual(["left_click"]);
});

test("an MCP row lists and calls through the daemon that serves that server", async () => {
  const server = core();
  const connection = mcpConnection(machineMcpRecord(), undefined);

  expect(listMcpTools(connection)).rejects.toThrow("is not connected");
  await connectDaemon(server, "my-mac", () => {}, { mcp: ["other"] });
  expect(listMcpTools(connection)).rejects.toThrow(
    'does not serve MCP server "echo"',
  );

  await connectDaemon(server, "my-mac", () => {}, {
    mcp: ["echo"],
    onMcp: (frame, socket): void => {
      if (frame.type === "mcp-list") {
        socket.send(
          JSON.stringify({
            type: "mcp-tools",
            id: frame.id,
            tools: [{ name: "echo", inputSchema: { type: "object" } }],
          }),
        );

        return;
      }

      const text = frame.args.text;
      if (typeof text !== "string") {
        throw new Error("Expected MCP echo text to be a string");
      }
      socket.send(
        JSON.stringify({
          type: "mcp-result",
          id: frame.id,
          result: {
            content: [{ type: "text", text: `echo: ${text}` }],
          },
        }),
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
  await connectDaemon(server, "my-mac", () => {}, {
    mcp: ["echo"],
    specs: { vcpu: 10, memoryMb: 32768, storageGb: 926 },
  });
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
    specs: { vcpu: 10, memoryMb: 32768, storageGb: 926 },
  });
  expect(second?.ref.connectionId).not.toBe(first?.ref.connectionId);
});

test("a policy deny stands in ask mode instead of becoming a prompt", async () => {
  const { approval } = createRuntimeToolApproval({
    configuredApprovals: new Map(),
    workspaces: [],
    sandboxes: [machine()],
    policyApproval: async (): Promise<ToolApprovalStatus> => "denied",
  });

  expect(
    await approval?.({
      toolCall: {
        type: "tool-call",
        toolCallId: "call-0",
        toolName: "computer",
        input: { action: "left_click" },
      },
      tools: {},
      toolsContext: {},
      runtimeContext: {},
      messages: [],
    }),
  ).toBe("denied");
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

test("a hello with a malformed size still connects, with no size", () => {
  expect(
    parseDaemonFrame(
      '{"type":"hello","sandbox":"my-mac","specs":{"vcpu":-1,"memoryMb":"8 GB"}}',
    ),
  ).toEqual({ type: "hello", sandbox: "my-mac", specs: undefined });
  expect(
    parseDaemonFrame(
      '{"type":"hello","sandbox":"my-mac","specs":{"vcpu":8,"memoryMb":16384}}',
    ),
  ).toEqual({
    type: "hello",
    sandbox: "my-mac",
    specs: { vcpu: 8, memoryMb: 16384 },
  });
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

// One ask-mode pass where the model clicks, then takes a screenshot.
async function askedClickThenScreenshot(ran: string[]): Promise<{
  messages: ModelMessage[];
  requests: ToolApprovalRequestOutput<ToolSet>[];
}> {
  const prompt: ModelMessage[] = [
    { role: "user", content: "click the field, then look" },
  ];
  const step = askModeStream(ran, Bun.sleep(10), {
    model: computerStepModel([
      { action: "left_click", coordinate: [10, 20] },
      { action: "screenshot" },
    ]),
    messages: prompt,
  });
  const content = await step.content;

  return {
    messages: [...prompt, ...(await step.response).messages],
    requests: content.flatMap((part): ToolApprovalRequestOutput<ToolSet>[] =>
      part.type === "tool-approval-request" ? [part] : [],
    ),
  };
}

// One streamText pass over a recording computer on an `ask` machine, wired
// like the harness. A click lasts until `clicked` settles.
function askModeStream(
  ran: string[],
  clicked: Promise<void>,
  options: {
    model: MockLanguageModelV4;
    messages: ModelMessage[];
    abortSignal?: AbortSignal;
  },
): ReturnType<typeof streamText> {
  const { tools, reserve } = serializeToolCalls(
    recordingComputer(ran, clicked),
    "computer",
  );
  const { approval, startStep } = createRuntimeToolApproval({
    configuredApprovals: new Map(),
    workspaces: [],
    sandboxes: [machine()],
  });

  return streamText({
    ...options,
    tools: tools,
    ...(approval ? { toolApproval: approval } : {}),
    onStepStart: startStep,
    onToolExecutionStart: ({ toolCall }): void => reserve(toolCall),
  });
}

// One model step that calls the computer tool with each input, in order.
function computerStepModel(
  inputs: Record<string, unknown>[],
): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: {
      stream: simulateReadableStream<LanguageModelV4StreamPart>({
        chunks: [
          ...inputs.map((input, index): LanguageModelV4StreamPart => ({
            type: "tool-call",
            toolCallId: `call-${index}`,
            toolName: "computer",
            input: JSON.stringify(input),
          })),
          {
            type: "finish",
            finishReason: { unified: "tool-calls", raw: "tool_use" },
            usage: {
              inputTokens: {
                total: 1,
                noCache: 1,
                cacheRead: 0,
                cacheWrite: 0,
              },
              outputTokens: { total: 1, text: 1, reasoning: 0 },
            },
          },
        ],
      }),
    },
  });
}

function connectDaemon(
  server: Bun.Server<MachineSocketData>,
  sandbox: string,
  onExec: (frame: MachineExecFrame, socket: WebSocket) => void,
  daemon: FakeDaemon = {},
): Promise<{ ready: MachineReadyFrame; socket: WebSocket }> {
  return new Promise((resolve, reject): void => {
    const socket = openSocket(server, daemon.token);
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
          specs: daemon.specs,
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
  token: string = MACHINE_ACCOUNT_SECRET,
): WebSocket {
  const socket = new WebSocket(
    `ws://127.0.0.1:${server.port}${MACHINE_WEBSOCKET_PATH}`,
    { headers: { authorization: `Bearer ${token}` } } as unknown as string[],
  );
  sockets.push(socket);

  return socket;
}

// A computer tool that records each action as it starts. A click lasts until
// `clicked` settles.
function recordingComputer(ran: string[], clicked: Promise<void>): ToolSet {
  return {
    computer: tool({
      inputSchema: z.object({ action: z.string() }).loose(),
      execute: async ({ action }): Promise<string> => {
        ran.push(action);
        if (action === "left_click") await clicked;

        return action;
      },
    }),
  };
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

// The next pass after a person answers each request of `asked`, in order, where
// the model then calls `next`. The click lasts until `stop` aborts when one is
// given.
function resumed(
  ran: string[],
  asked: Awaited<ReturnType<typeof askedClickThenScreenshot>>,
  answers: boolean[],
  next: Record<string, unknown>[],
  stop?: AbortController,
): ReturnType<typeof streamText> {
  const clicked = stop
    ? new Promise<void>((resolve): void => {
        stop.signal.addEventListener("abort", (): void => resolve());
      })
    : Bun.sleep(10);

  return askModeStream(ran, clicked, {
    model: computerStepModel(next),
    messages: [
      ...asked.messages,
      {
        role: "tool",
        content: asked.requests.map((request, index): ToolApprovalResponse => ({
          type: "tool-approval-response",
          approvalId: request.approvalId,
          approved: answers[index] === true,
        })),
      },
    ],
    ...(stop ? { abortSignal: stop.signal } : {}),
  });
}
