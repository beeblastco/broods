/**
 * A machine socket lives no longer than the credential that opened it: a stage
 * ticket closes it at its expiry, and a bearer that stops resolving loses it at
 * the next heartbeat. The fake daemon only trades frames on loopback and never
 * runs a command.
 */

import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import {
  sealStageSessionTicket,
  type StageSessionTicket,
} from "@broods/convex/model/stageSessionTicket";
import {
  isMachineConnected,
  MachineSandboxExecutor,
  type MachineSocketData,
} from "../src/harness/sandbox/machine-executor.ts";
import { resolveBearerAuth } from "../src/shared/auth.ts";
import {
  MACHINE_CLOSE,
  MACHINE_WEBSOCKET_PATH,
  parseCoreFrame,
  type MachineExecFrame,
  type MachineReadyFrame,
} from "../src/shared/machine-socket.ts";
import {
  resetStorageForTests,
  setStorageForTests,
} from "../src/shared/storage.ts";
import {
  closeOf,
  MACHINE_ACCOUNT_ID,
  MACHINE_ACCOUNT_SECRET,
  machineExecutorConfig,
  machineStorage,
  startMachineCore,
  type MachineConnectionWrite,
} from "./helpers/machine.ts";

const SECRET = "machine-expiry-ticket-secret";
const sockets: WebSocket[] = [];
const servers: Bun.Server<MachineSocketData>[] = [];
let previousSecret: string | undefined;

beforeEach((): void => {
  previousSecret = process.env.STAGE_TICKET_SECRET;
  process.env.STAGE_TICKET_SECRET = SECRET;
});

afterEach(async (): Promise<void> => {
  jest.useRealTimers();
  for (const socket of sockets.splice(0)) socket.close();
  for (const server of servers.splice(0)) await server.stop(true);
  resetStorageForTests();
  if (previousSecret === undefined) delete process.env.STAGE_TICKET_SECRET;
  else process.env.STAGE_TICKET_SECRET = previousSecret;
});

test("a stage ticket's daemon that sends no fresh one is closed at the ticket's expiry and gets no exec after it", async (): Promise<void> => {
  const writes: MachineConnectionWrite[] = [];
  setStorageForTests(machineStorage(writes));
  jest.useFakeTimers();
  const expiresAt = Date.now() + 1500;
  const token = await ticket(expiresAt);
  const server = core();
  const received: MachineExecFrame[] = [];
  const held = Promise.withResolvers<void>();
  // Answers the first exec, holds the second open across the expiry.
  const daemon = await connectDaemon(server, token, (frame, socket): void => {
    received.push(frame);
    if (received.length === 1) socket.send(JSON.stringify(result(frame.id)));
    else held.resolve();
  });
  const closed = closeOf(daemon);
  const executor = new MachineSandboxExecutor(machineExecutorConfig());

  const before = await executor.run({
    code: "fixture-only-never-executed",
    envVars: { FRESH_SECRET: "sent-while-the-ticket-lives" },
    timeoutSeconds: 5,
    outputLimitBytes: 1024,
  });
  expect(before.ok).toBe(true);
  const inFlight = executor
    .run({ code: "held", timeoutSeconds: 5, outputLimitBytes: 1024 })
    .then(
      (): string => "resolved",
      (error: Error): string => error.message,
    );
  // The held exec must reach the daemon before the clock moves past the ticket.
  // Awaited, not polled: the frame crosses a real socket, which only the event
  // loop delivers, and an await leaves the test timeout free to fire.
  await held.promise;
  jest.advanceTimersByTime(expiresAt - 1 - Date.now());
  expect(isMachineConnected(machineExecutorConfig())).toBe(true);
  jest.advanceTimersByTime(1);

  const close = await closed;
  expect(close.code).toBe(MACHINE_CLOSE.expired.code);
  expect(close.reason).toBe(MACHINE_CLOSE.expired.reason);
  expect(await inFlight).toBe(
    'machine sandbox "my-mac" disconnected while the command was running',
  );
  expect(writes.map((write) => write.kind)).toEqual([
    "connected",
    "disconnected",
  ]);

  // The same ticket opens nothing now, and the record has no daemon to send to.
  expect(
    await resolveBearerAuth({ authorization: `Bearer ${token}` }),
  ).toBeNull();
  const refused = openSocket(server, token);
  const refusal = closeOf(refused);
  refused.onopen = (): void =>
    refused.send(JSON.stringify({ type: "hello", sandbox: "my-mac" }));
  expect((await refusal).code).toBe(MACHINE_CLOSE.unauthorized.code);
  expect(
    executor.run({
      code: "fixture-only-never-executed",
      envVars: { FRESH_SECRET: "created-after-expiry" },
      timeoutSeconds: 1,
      outputLimitBytes: 1024,
    }),
  ).rejects.toThrow('machine sandbox "my-mac" is not connected');
  expect(received.map((frame) => frame.env?.FRESH_SECRET)).toEqual([
    "sent-while-the-ticket-lives",
    undefined,
  ]);
}, 10_000);

test("a fresh ticket before the expiry keeps the daemon past it, and frames still flow", async (): Promise<void> => {
  setStorageForTests(machineStorage());
  jest.useFakeTimers();
  const expiresAt = Date.now() + 1000;
  const daemon = await connectDaemon(
    core(),
    await ticket(expiresAt),
    (frame, socket): void => socket.send(JSON.stringify(result(frame.id))),
  );
  let closed = false;
  daemon.onclose = (): void => {
    closed = true;
  };
  const acked = nextReady(daemon);

  daemon.send(
    JSON.stringify({
      type: "credential",
      token: await ticket(Date.now() + 60_000),
    }),
  );
  expect((await acked).expiresInMs).toBeGreaterThan(55_000);
  jest.advanceTimersByTime(expiresAt + 500 - Date.now());

  const after = await new MachineSandboxExecutor(machineExecutorConfig()).run({
    code: "fixture-only-never-executed",
    timeoutSeconds: 1,
    outputLimitBytes: 1024,
  });
  expect(after.ok).toBe(true);
  expect(closed).toBe(false);
}, 10_000);

test("a fresh ticket for another stage or account, or one that cannot write sandboxes, closes the daemon as unauthorized", async (): Promise<void> => {
  const storage = machineStorage();
  setStorageForTests(storage);
  // Any account resolves, so the other account's ticket is refused for the
  // mismatch rather than for being unknown.
  const own = await storage.accounts.getById(MACHINE_ACCOUNT_ID);
  storage.accounts.getById = async (accountId: string) =>
    own && { ...own, accountId: accountId };
  const server = core();
  const expiresAt = Date.now() + 60_000;

  const refreshes: Partial<StageSessionTicket>[] = [
    { stageId: "stage_prod" },
    { accountId: "acct_other" },
    // A plain member's dashboard ticket.
    { sandboxWrite: undefined },
  ];
  for (const refresh of refreshes) {
    const daemon = await connectDaemon(
      server,
      await ticket(expiresAt),
      (): void => {},
    );
    const closed = closeOf(daemon);
    daemon.send(
      JSON.stringify({
        type: "credential",
        token: await ticket(expiresAt + 60_000, refresh),
      }),
    );

    expect((await closed).code).toBe(MACHINE_CLOSE.unauthorized.code);
  }
});

test("a frame bound for a daemon past its ticket is refused even before the expiry timer runs", async (): Promise<void> => {
  setStorageForTests(machineStorage());
  // The expiry timer is fake, so it never fires; only the clock moves.
  jest.useFakeTimers();
  const expiresAt = Date.now() + 60_000;
  const received: MachineExecFrame[] = [];
  const daemon = await connectDaemon(
    core(),
    await ticket(expiresAt),
    (frame): void => {
      received.push(frame);
    },
  );
  const closed = closeOf(daemon);
  jest.setSystemTime(expiresAt);

  expect(
    new MachineSandboxExecutor(machineExecutorConfig()).run({
      code: "fixture-only-never-executed",
      envVars: { FRESH_SECRET: "created-after-expiry" },
      timeoutSeconds: 1,
      outputLimitBytes: 1024,
    }),
  ).rejects.toThrow("reconnecting with a fresh credential");
  expect((await closed).code).toBe(MACHINE_CLOSE.expired.code);
  expect(received).toEqual([]);
});

test("a daemon whose bearer stops resolving loses its socket at the next heartbeat", async (): Promise<void> => {
  const storage = machineStorage();
  setStorageForTests(storage);
  jest.useFakeTimers();
  const daemon = await connectDaemon(
    core(),
    MACHINE_ACCOUNT_SECRET,
    (frame, socket): void => socket.send(JSON.stringify(result(frame.id))),
  );
  const closed = closeOf(daemon);

  // A heartbeat that cannot reach storage keeps the daemon: it still runs.
  let lookups = 0;
  storage.accounts.getBySecretHash = async (): Promise<null> => {
    lookups += 1;
    throw new Error("storage down");
  };
  jest.advanceTimersByTime(60_000);
  const kept = await new MachineSandboxExecutor(machineExecutorConfig()).run({
    code: "fixture-only-never-executed",
    timeoutSeconds: 1,
    outputLimitBytes: 1024,
  });
  expect(lookups).toBe(1);
  expect(kept.ok).toBe(true);

  // The key was rotated away, or the account suspended.
  storage.accounts.getBySecretHash = async (): Promise<null> => null;
  jest.advanceTimersByTime(60_000);

  expect((await closed).code).toBe(MACHINE_CLOSE.unauthorized.code);
});

test("an older ticket that lands after a newer one never moves the deadline back", async (): Promise<void> => {
  setStorageForTests(machineStorage());
  const daemon = await connectDaemon(
    core(),
    await ticket(Date.now() + 1000),
    (frame, socket): void => socket.send(JSON.stringify(result(frame.id))),
  );
  let closed = false;
  daemon.onclose = (): void => {
    closed = true;
  };
  const acked = nextReady(daemon);

  daemon.send(
    JSON.stringify({
      type: "credential",
      token: await ticket(Date.now() + 60_000),
    }),
  );
  await acked;
  daemon.send(
    JSON.stringify({
      type: "credential",
      token: await ticket(Date.now() + 1500),
    }),
  );
  await Bun.sleep(2000);

  expect(closed).toBe(false);
}, 10_000);

test("a role session whose policy stops granting sandboxes:write loses its socket at the next heartbeat", async (): Promise<void> => {
  const storage = machineStorage();
  setStorageForTests(storage);
  jest.useFakeTimers();
  let actions = ["sandboxes:write"];
  storage.roleSessions.resolveByTokenHash = async () => ({
    accountId: MACHINE_ACCOUNT_ID,
    roleId: "role_machine",
    policy: {
      version: 1,
      mode: "enforce",
      rules: [{ id: "machine", effect: "allow", actions: actions }],
    },
  });
  const daemon = await connectDaemon(
    core(),
    `bsts_${crypto.randomUUID()}`,
    (): void => {},
  );
  const closed = closeOf(daemon);

  actions = ["sandboxes:read"];
  jest.advanceTimersByTime(60_000);

  expect((await closed).code).toBe(MACHINE_CLOSE.unauthorized.code);
});

function core(): Bun.Server<MachineSocketData> {
  const server = startMachineCore();
  servers.push(server);

  return server;
}

/** Claims `my-mac` and resolves once core says ready. */
function connectDaemon(
  server: Bun.Server<MachineSocketData>,
  token: string,
  onExec: (frame: MachineExecFrame, socket: WebSocket) => void,
): Promise<WebSocket> {
  return new Promise((resolve, reject): void => {
    const socket = openSocket(server, token);
    socket.onopen = (): void =>
      socket.send(
        JSON.stringify({
          type: "hello",
          sandbox: "my-mac",
          instance: "expiry-daemon",
        }),
      );
    socket.onmessage = (event): void => {
      const frame = parseCoreFrame(String(event.data));
      if (frame?.type === "ready") resolve(socket);
      if (frame?.type === "exec") onExec(frame, socket);
    };
    socket.onclose = (event): void =>
      reject(new Error(`closed ${event.code} ${event.reason}`));
  });
}

function nextReady(socket: WebSocket): Promise<MachineReadyFrame> {
  return new Promise((resolve): void => {
    socket.addEventListener("message", (event): void => {
      const frame = parseCoreFrame(String(event.data));
      if (frame?.type === "ready") resolve(frame);
    });
  });
}

function openSocket(
  server: Bun.Server<MachineSocketData>,
  token: string,
): WebSocket {
  const socket = new WebSocket(
    `ws://127.0.0.1:${server.port}${MACHINE_WEBSOCKET_PATH}`,
    { headers: { authorization: `Bearer ${token}` } } as unknown as string[],
  );
  sockets.push(socket);

  return socket;
}

function result(id: string): Record<string, unknown> {
  return {
    type: "result",
    id: id,
    stdout: "fixture-only",
    stderr: "",
    exitCode: 0,
    durationMs: 0,
    timedOut: false,
    truncated: false,
  };
}

/** A `broods login` ticket for the development stage, able to claim a machine. */
function ticket(
  expiresAt: number,
  overrides: Partial<StageSessionTicket> = {},
): Promise<string> {
  return sealStageSessionTicket(
    {
      accountId: MACHINE_ACCOUNT_ID,
      endpointId: "endpoint",
      projectId: "proj",
      projectSlug: "demo",
      stageId: "stage_dev",
      stageSlug: "development",
      sandboxWrite: true,
      expiresAt: expiresAt,
      ...overrides,
    },
    SECRET,
  );
}
