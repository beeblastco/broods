import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
  cleanupTerminalSocket,
  openTerminalUpstream,
  relayTerminalInput,
  type MachineGatewayData,
} from "../../gateway/src/terminal.ts";
import { runMachineDaemon } from "../../../packages/broods/src/cli/machine.ts";
import {
  callMcpTool,
  listMcpTools,
  mcpConnection,
} from "../src/harness/mcp/client.ts";
import { MachineSandboxExecutor } from "../src/harness/sandbox/machine-executor.ts";
import {
  MACHINE_CLOSE,
  MACHINE_WEBSOCKET_PATH,
  machineSocketUrl,
} from "../src/shared/machine-socket.ts";
import {
  resetStorageForTests,
  setStorageForTests,
} from "../src/shared/storage.ts";
import {
  MACHINE_RUNTIME_KEY,
  MACHINE_SANDBOX_ID,
  machineExecutorConfig,
  machineMcpRecord,
  machineStorage,
  startMachineCore,
} from "./helpers/machine.ts";

// Gateway routing is covered in apps/gateway/tests/route.test.ts; importing
// main.ts here would pull the gateway into core's typecheck.

const ECHO_SERVER = join(
  import.meta.dir,
  "../../../packages/broods/tests/fixtures/echo-mcp-server.ts",
);
const servers: Bun.Server<unknown>[] = [];
const controllers: AbortController[] = [];

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.abort();
  for (const server of servers.splice(0)) server.stop(true);
  resetStorageForTests();
});

test("the CLI daemon runs bash on this machine through the gateway relay", async () => {
  setStorageForTests(machineStorage());
  const lines: string[] = [];
  const controller = daemonController();
  const daemon = runMachineDaemon({
    apiKey: MACHINE_RUNTIME_KEY,
    baseUrl: startDoor(coreUrl()),
    cwd: "/tmp",
    log: (line) => lines.push(line),
    sandbox: "my-mac",
    signal: controller.signal,
  });
  await waitFor(() =>
    lines.includes(`connected as my-mac (${MACHINE_SANDBOX_ID})`),
  );

  const result = await new MachineSandboxExecutor(
    machineExecutorConfig({ envVars: { RELAY: "yes" } }),
  ).run({
    code: "echo relay=$RELAY host=$(hostname)",
    timeoutSeconds: 10,
    outputLimitBytes: 4096,
  });

  expect(result.ok).toBe(true);
  expect(result.stdout).toBe(`relay=yes host=${hostname()}\n`);
  expect(lines).toContain("$ echo relay=$RELAY host=$(hostname)");

  controller.abort();
  await daemon;
});

test("core's MCP client lists and calls a stdio server on this machine through the relay", async () => {
  setStorageForTests(machineStorage());
  const lines: string[] = [];
  const controller = daemonController();
  const daemon = runMachineDaemon({
    apiKey: MACHINE_RUNTIME_KEY,
    baseUrl: startDoor(coreUrl()),
    cwd: "/tmp",
    log: (line) => lines.push(line),
    mcpFile: mcpServersFile(),
    sandbox: "my-mac",
    signal: controller.signal,
  });
  await waitFor(() =>
    lines.includes(`connected as my-mac (${MACHINE_SANDBOX_ID})`),
  );
  const connection = mcpConnection(machineMcpRecord(), undefined);

  expect((await listMcpTools(connection)).map((tool) => tool.name)).toEqual([
    "echo",
  ]);
  expect(await callMcpTool(connection, "echo", { text: "relay" })).toBe(
    "echo: relay",
  );

  controller.abort();
  await daemon;
});

test("a bad key reaches the daemon as core's 4401 and stops it", async () => {
  setStorageForTests(machineStorage());

  await expect(
    runMachineDaemon({
      apiKey: "wrong-key",
      baseUrl: startDoor(coreUrl()),
      cwd: "/tmp",
      log: () => {},
      sandbox: "my-mac",
      signal: daemonController().signal,
    }),
  ).rejects.toThrow(MACHINE_CLOSE.unauthorized.reason);
});

test("an unreachable core is a reconnect, not a refusal", async () => {
  const gone = Bun.serve({ port: 0, fetch: () => new Response("gone") });
  const goneUrl = `http://127.0.0.1:${gone.port}`;
  gone.stop(true);
  const lines: string[] = [];
  const controller = daemonController();
  const daemon = runMachineDaemon({
    apiKey: MACHINE_RUNTIME_KEY,
    baseUrl: startDoor(goneUrl),
    cwd: "/tmp",
    log: (line) => lines.push(line),
    sandbox: "my-mac",
    signal: controller.signal,
  });

  await waitFor(() => lines.some((line) => line.startsWith("disconnected (")));
  controller.abort();
  expect(await daemon).toBeUndefined();
});

function coreUrl(): string {
  const core = startMachineCore();
  servers.push(core);

  return `http://127.0.0.1:${core.port}`;
}

function daemonController(): AbortController {
  const controller = new AbortController();
  controllers.push(controller);

  return controller;
}

function mcpServersFile(): string {
  const file = join(
    mkdtempSync(join(tmpdir(), "broods-relay-mcp-")),
    "mcp.json",
  );
  writeFileSync(
    file,
    JSON.stringify({
      mcpServers: { echo: { command: "bun", args: [ECHO_SERVER] } },
    }),
  );

  return file;
}

/** The gateway's machine branch on its real relay. */
function startDoor(upstreamBaseUrl: string): string {
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
          url: machineSocketUrl(upstreamBaseUrl),
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

  return `http://127.0.0.1:${door.port}`;
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
