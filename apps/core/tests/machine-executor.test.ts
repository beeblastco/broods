import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  MachineSandboxExecutor,
  isMachineUpgrade,
  machineWebSocketHandler,
  upgradeMachineSocket,
  type MachineSocketData,
} from "../src/harness/sandbox/machine-executor.ts";
import type { SandboxExecutorConfig } from "../src/harness/sandbox/types.ts";
import type { AccountRecord } from "../src/shared/domain/accounts.ts";
import type { SandboxConfigRecord } from "../src/shared/domain/sandbox-config.ts";
import { MACHINE_WEBSOCKET_PATH } from "../src/shared/machine-socket.ts";
import {
  resetStorageForTests,
  setStorageForTests,
  type Storage,
} from "../src/shared/storage.ts";

/**
 * Core's half of the machine sandbox: the daemon socket claims a record, the
 * executor turns `run` into an exec frame on that socket, and a missing or
 * replaced daemon fails the call with a reason the model can act on.
 */

const ACCOUNT_ID = "acct_machine";
const SANDBOX_ID = "sbx_machine";
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
  const server = coreServer();
  const daemon = await connectDaemon(server, "my-mac", (frame, socket) => {
    socket.send(
      JSON.stringify({
        type: "result",
        id: frame.id,
        exitCode: 0,
        stdout: `ran: ${frame.code} in ${frame.cwd} as ${frame.env?.WHO}`,
        stderr: "",
        durationMs: 7,
      }),
    );
  });
  expect(daemon.ready.sandboxId).toBe(SANDBOX_ID);

  const result = await new MachineSandboxExecutor(
    executorConfig({
      options: { cwd: "/Users/me/app" },
      envVars: { WHO: "me" },
    }),
  ).run({ code: "echo hi", timeoutSeconds: 5, outputLimitBytes: 1024 });

  expect(result).toMatchObject({
    ok: true,
    exitCode: 0,
    stdout: "ran: echo hi in /Users/me/app as me",
    durationMs: 7,
    provider: "machine",
  });
});

test("a run with no daemon connected names the command to fix it", async () => {
  coreServer();

  await expect(
    new MachineSandboxExecutor(executorConfig({})).run({
      code: "true",
      timeoutSeconds: 5,
      outputLimitBytes: 1024,
    }),
  ).rejects.toThrow(
    'machine sandbox "my-mac" is not connected. Run `broods machine my-mac`',
  );
});

test("a second daemon replaces the first, and a dropped daemon fails its in-flight run", async () => {
  const server = coreServer();
  const first = await connectDaemon(server, "my-mac", () => {});
  const firstClosed = new Promise<CloseEvent>((resolve) => {
    first.socket.onclose = resolve;
  });
  // Settled by the replacement before this test can await it, so the handler
  // is attached up front.
  const pending = new MachineSandboxExecutor(executorConfig({}))
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
  const server = coreServer();

  const closed = await connectDaemonExpectingClose(server, "cloud-box");

  expect(closed.code).toBe(4404);
});

test("the upgrade refuses a bad bearer and ignores non-machine paths", async () => {
  const server = coreServer();
  expect(
    isMachineUpgrade(
      new Request(`http://x${MACHINE_WEBSOCKET_PATH}`, {
        headers: { upgrade: "websocket" },
      }),
    ),
  ).toBe(true);
  expect(isMachineUpgrade(new Request("http://x/v1/runs"))).toBe(false);

  const response = await upgradeMachineSocket(
    new Request(`http://x${MACHINE_WEBSOCKET_PATH}`, {
      headers: { upgrade: "websocket", authorization: "Bearer nope" },
    }),
    server,
  );

  expect(response?.status).toBe(401);
});

function coreServer(): Bun.Server<MachineSocketData> {
  const server = Bun.serve<MachineSocketData>({
    port: 0,
    fetch: (request, bunServer) =>
      isMachineUpgrade(request)
        ? upgradeMachineSocket(request, bunServer)
        : new Response("not found", { status: 404 }),
    websocket: machineWebSocketHandler,
  });
  servers.push(server);

  return server;
}

function connectDaemon(
  server: Bun.Server<MachineSocketData>,
  sandbox: string,
  onExec: (
    frame: {
      id: string;
      code: string;
      cwd?: string;
      env?: Record<string, string>;
    },
    socket: WebSocket,
  ) => void,
): Promise<{ ready: { sandboxId: string }; socket: WebSocket }> {
  return new Promise((resolve, reject) => {
    const socket = openSocket(server);
    let ready = false;
    socket.onopen = () =>
      socket.send(JSON.stringify({ type: "hello", sandbox: sandbox }));
    socket.onmessage = (event) => {
      const frame = JSON.parse(String(event.data));
      if (frame.type === "ready") {
        ready = true;
        resolve({ ready: frame, socket: socket });
      }
      if (frame.type === "exec") onExec(frame, socket);
    };
    socket.onclose = (event) => {
      if (!ready) reject(new Error(`closed ${event.code} ${event.reason}`));
    };
  });
}

function connectDaemonExpectingClose(
  server: Bun.Server<MachineSocketData>,
  sandbox: string,
): Promise<CloseEvent> {
  return new Promise((resolve) => {
    const socket = openSocket(server);
    socket.onopen = () =>
      socket.send(JSON.stringify({ type: "hello", sandbox: sandbox }));
    socket.onclose = resolve;
  });
}

function executorConfig(
  overrides: Partial<SandboxExecutorConfig>,
): SandboxExecutorConfig {
  return {
    provider: "machine",
    controlPlane: {
      accountId: ACCOUNT_ID,
      sandboxConfigId: SANDBOX_ID,
      name: "my-mac",
      specs: { vcpu: 0, memoryMb: 0, storageGb: 0 },
    },
    ...overrides,
  };
}

function machineStorage(): Storage {
  const account: AccountRecord = {
    accountId: ACCOUNT_ID,
    username: "machine",
    secretHash: "hash",
    status: "active",
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  };
  const records: SandboxConfigRecord[] = [
    {
      accountId: ACCOUNT_ID,
      sandboxId: SANDBOX_ID,
      name: "my-mac",
      config: {
        provider: "machine",
        permissionMode: "ask",
        network: { mode: "allow-all" },
      },
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
    },
    {
      accountId: ACCOUNT_ID,
      sandboxId: "sbx_cloud",
      name: "cloud-box",
      config: {
        provider: "lambda",
        permissionMode: "ask",
        network: { mode: "deny-all" },
      },
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
    },
  ];

  return {
    accounts: {
      getById: async (accountId: string) =>
        accountId === ACCOUNT_ID ? account : null,
      getBySecretHash: async () => null,
    },
    agentDeployments: {
      getByApiKeyHash: async (hash: string) =>
        hash === runtimeKeyHash()
          ? {
              accountId: ACCOUNT_ID,
              endpointId: "endpoint",
              projectSlug: "demo",
              stageSlug: "development",
            }
          : null,
    },
    sandboxConfigs: {
      getById: async (_accountId: string, sandboxId: string) =>
        records.find((record) => record.sandboxId === sandboxId) ?? null,
      list: async () => records,
      removeAllForAccount: async () => 0,
    },
  } as unknown as Storage;
}

function openSocket(server: Bun.Server<MachineSocketData>): WebSocket {
  const socket = new WebSocket(
    `ws://127.0.0.1:${server.port}${MACHINE_WEBSOCKET_PATH}`,
    { headers: { authorization: "Bearer runtime-key" } } as unknown as string[],
  );
  sockets.push(socket);

  return socket;
}

function runtimeKeyHash(): string {
  return new Bun.CryptoHasher("sha256").update("runtime-key").digest("hex");
}
