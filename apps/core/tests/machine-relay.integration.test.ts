import { afterEach, expect, test } from "bun:test";
import { hostname } from "node:os";
import {
  cleanupTerminalSocket,
  openTerminalUpstream,
  relayTerminalInput,
  type MachineGatewayData,
} from "../../gateway/src/terminal.ts";
import { runMachineDaemon } from "../../../packages/broods/src/cli/machine.ts";
import {
  MachineSandboxExecutor,
  isMachineUpgrade,
  machineWebSocketHandler,
  upgradeMachineSocket,
  type MachineSocketData,
} from "../src/harness/sandbox/machine-executor.ts";
import type { AccountRecord } from "../src/shared/domain/accounts.ts";
import {
  MACHINE_WEBSOCKET_PATH,
  machineSocketUrl,
} from "../src/shared/machine-socket.ts";
import {
  resetStorageForTests,
  setStorageForTests,
  type Storage,
} from "../src/shared/storage.ts";

/**
 * The whole machine sandbox path on one computer, minus the model: the real
 * CLI daemon dials a door built on the gateway's relay module, the relay
 * pipes to core's socket handler, and `MachineSandboxExecutor.run` comes back
 * with bash output from this host. The gateway's own routing to that relay is
 * covered in apps/gateway/tests/route.test.ts; importing its entry here would
 * drag the gateway's whole dependency graph into core's typecheck.
 */

const ACCOUNT_ID = "acct_relay";
const SANDBOX_ID = "sbx_relay";
const servers: Bun.Server<unknown>[] = [];
const controllers: AbortController[] = [];

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.abort();
  for (const server of servers.splice(0)) server.stop(true);
  resetStorageForTests();
});

test("daemon → gateway relay → core → executor runs bash on this machine", async () => {
  setStorageForTests(relayStorage());
  const door = startDoor(startCore());
  const lines: string[] = [];
  const controller = daemonController();
  const daemon = runMachineDaemon({
    apiKey: "runtime-key",
    baseUrl: `http://127.0.0.1:${door.port}`,
    cwd: "/tmp",
    log: (line) => lines.push(line),
    sandbox: "my-mac",
    signal: controller.signal,
  });
  await waitFor(() => lines.includes(`connected as my-mac (${SANDBOX_ID})`));

  const result = await new MachineSandboxExecutor({
    provider: "machine",
    envVars: { RELAY: "yes" },
    controlPlane: {
      accountId: ACCOUNT_ID,
      sandboxConfigId: SANDBOX_ID,
      name: "my-mac",
      specs: { vcpu: 0, memoryMb: 0, storageGb: 0 },
    },
  }).run({
    code: "echo relay=$RELAY host=$(hostname)",
    timeoutSeconds: 10,
    outputLimitBytes: 4096,
  });

  expect(result.ok).toBe(true);
  expect(result.stdout).toBe(`relay=yes host=${hostname()}\n`);
  expect(result.provider).toBe("machine");
  expect(lines).toContain("$ echo relay=$RELAY host=$(hostname)");

  controller.abort();
  await daemon;
});

test("a refused core upgrade reaches the daemon as a readable close, not a bare 1006", async () => {
  setStorageForTests(relayStorage());
  const door = startDoor(startCore());

  await expect(
    runMachineDaemon({
      apiKey: "wrong-key",
      baseUrl: `http://127.0.0.1:${door.port}`,
      cwd: "/tmp",
      log: () => {},
      sandbox: "my-mac",
      signal: daemonController().signal,
    }),
  ).rejects.toThrow("Core refused the machine socket");
});

function daemonController(): AbortController {
  const controller = new AbortController();
  controllers.push(controller);

  return controller;
}

function relayStorage(): Storage {
  const account: AccountRecord = {
    accountId: ACCOUNT_ID,
    username: "relay",
    secretHash: "hash",
    status: "active",
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  };
  const runtimeKeyHash = new Bun.CryptoHasher("sha256")
    .update("runtime-key")
    .digest("hex");

  return {
    accounts: {
      getById: async (accountId: string) =>
        accountId === ACCOUNT_ID ? account : null,
      getBySecretHash: async () => null,
    },
    agentDeployments: {
      getByApiKeyHash: async (hash: string) =>
        hash === runtimeKeyHash
          ? {
              accountId: ACCOUNT_ID,
              endpointId: "endpoint",
              projectSlug: "demo",
              stageSlug: "development",
            }
          : null,
    },
    sandboxConfigs: {
      getById: async () => null,
      list: async () => [
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
      ],
      removeAllForAccount: async () => 0,
    },
  } as unknown as Storage;
}

function startCore(): Bun.Server<MachineSocketData> {
  const core = Bun.serve<MachineSocketData>({
    port: 0,
    fetch: (request, bunServer) =>
      isMachineUpgrade(request)
        ? upgradeMachineSocket(request, bunServer)
        : new Response("not found", { status: 404 }),
    websocket: machineWebSocketHandler,
  });
  servers.push(core);

  return core;
}

/** What apps/gateway/src/main.ts does for MACHINE_WEBSOCKET_PATH, on the real relay. */
function startDoor(
  core: Bun.Server<MachineSocketData>,
): Bun.Server<MachineGatewayData> {
  const door = Bun.serve<MachineGatewayData>({
    port: 0,
    fetch: (request, bunServer) => {
      const url = new URL(request.url);
      const token = request.headers
        .get("sec-websocket-protocol")
        ?.split(",")
        .map((entry) => entry.trim())
        .find((entry) => entry.startsWith("broods.token."))
        ?.slice("broods.token.".length);
      if (url.pathname !== MACHINE_WEBSOCKET_PATH || !token) {
        return new Response("not found", { status: 404 });
      }
      const data: MachineGatewayData = {
        kind: "machine",
        ticket: {
          url: machineSocketUrl(`http://127.0.0.1:${core.port}`),
          authorization: `Bearer ${token}`,
        },
      };

      return bunServer.upgrade(request, {
        headers: { "Sec-WebSocket-Protocol": "broods.v1" },
        data: data,
      })
        ? undefined
        : new Response("upgrade failed", { status: 400 });
    },
    websocket: {
      open: openTerminalUpstream,
      message: relayTerminalInput,
      close: cleanupTerminalSocket,
    },
  });
  servers.push(door);

  return door;
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
