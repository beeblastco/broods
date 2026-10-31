import { afterEach, expect, test } from "bun:test";
import {
  MACHINE_CLOSE,
  matchBrowserSocketPath,
  type BrowserAction as CoreBrowserAction,
} from "../../../apps/core/src/shared/machine-socket.ts";
import {
  browserSocketUrl,
  connectBrowser,
  type BrowserAction,
  type BrowserConnection,
  type BrowserConnectionStatus,
} from "../src/browser-client.ts";

/** Holds when the SDK's action union and core's are the same type. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** A fake core: records what the browser sends and lets a test answer. */
interface FakeCore {
  frames: Record<string, unknown>[];
  protocols: string[];
  server: Bun.Server<undefined>;
  socket: () => Bun.ServerWebSocket<undefined>;
}

const connections: BrowserConnection[] = [];
const servers: Bun.Server<undefined>[] = [];

afterEach(async (): Promise<void> => {
  for (const connection of connections.splice(0)) connection.close();
  for (const server of servers.splice(0)) await server.stop(true);
});

test("the SDK's action union and socket path are core's", () => {
  const same: Same<BrowserAction, CoreBrowserAction> = true;
  const url = new URL(
    browserSocketUrl({
      baseUrl: "https://api.broods.app",
      projectId: "proj_1",
      stageId: "stage_1",
    }),
  );

  expect(same).toBe(true);
  expect(url.protocol).toBe("wss:");
  expect(matchBrowserSocketPath(url.pathname)).toEqual({
    projectId: "proj_1",
    stageId: "stage_1",
  });
});

test("it says hello as a browser, answers an action, and refreshes its ticket", async () => {
  const core = fakeCore();
  let tickets = 0;
  const statuses: BrowserConnectionStatus[] = [];
  connections.push(
    connectBrowser({
      url: `ws://127.0.0.1:${core.server.port}/v1/projects/p/stages/s/browsers/ws`,
      getTicket: async (): Promise<string> => `bbt_${++tickets}`,
      sandbox: "web",
      instance: "ext-1",
      onAction: async (action) => ({ text: `did ${action.action}` }),
      onStatus: (status): void => {
        statuses.push(status);
      },
    }),
  );
  await waitFor((): boolean => core.frames.length === 1);

  expect(core.protocols).toEqual(["broods.v1", "broods.token.bbt_1"]);
  expect(core.frames[0]).toEqual({
    type: "hello",
    sandbox: "web",
    instance: "ext-1",
    browser: true,
  });
  // Two seconds left: the refresh goes in at the one-second floor.
  core
    .socket()
    .send(
      JSON.stringify({ type: "ready", sandboxId: "sbx", expiresInMs: 2000 }),
    );
  core.socket().send(
    JSON.stringify({
      type: "browser",
      id: "a1",
      input: { action: "read_page" },
    }),
  );
  await waitFor((): boolean => core.frames.length >= 3, 3_000);

  expect(statuses[0]).toEqual({ kind: "connected", sandboxId: "sbx" });
  expect(core.frames).toContainEqual({
    type: "browser-result",
    id: "a1",
    text: "did read_page",
  });
  expect(core.frames).toContainEqual({ type: "credential", token: "bbt_2" });
});

test("a refusal it cannot fix stops it; any other close reconnects with a fresh ticket", async () => {
  for (const [code, stops] of [
    [MACHINE_CLOSE.forbidden.code, true],
    [MACHINE_CLOSE.originRefused.code, true],
    [MACHINE_CLOSE.unknownBrowser.code, true],
    [MACHINE_CLOSE.replaced.code, true],
    [MACHINE_CLOSE.ticketRefused.code, false],
    [MACHINE_CLOSE.expired.code, false],
  ] as const) {
    const core = fakeCore();
    let tickets = 0;
    const statuses: BrowserConnectionStatus[] = [];
    connections.push(
      connectBrowser({
        url: `ws://127.0.0.1:${core.server.port}/`,
        getTicket: async (): Promise<string> => `bbt_${++tickets}`,
        sandbox: "web",
        instance: "ext-1",
        onAction: async () => ({}),
        onStatus: (status): void => {
          statuses.push(status);
        },
      }),
    );
    await waitFor((): boolean => core.frames.length === 1);
    core.socket().close(code, "refused");
    await waitFor((): boolean => statuses.length > 0);

    expect(statuses[0]?.kind).toBe(stops ? "stopped" : "disconnected");
  }
});

function fakeCore(): FakeCore {
  const frames: Record<string, unknown>[] = [];
  let protocols: string[] = [];
  let socket: Bun.ServerWebSocket<undefined> | undefined;
  const server = Bun.serve<undefined>({
    port: 0,
    fetch: (request, bunServer) => {
      protocols = (request.headers.get("sec-websocket-protocol") ?? "")
        .split(",")
        .map((entry) => entry.trim());

      return bunServer.upgrade(request, {
        data: undefined,
        headers: { "Sec-WebSocket-Protocol": "broods.v1" },
      })
        ? undefined
        : new Response("no", { status: 400 });
    },
    websocket: {
      open: (opened): void => {
        socket = opened;
      },
      message: (_socket, raw): void => {
        frames.push(JSON.parse(String(raw)) as Record<string, unknown>);
      },
    },
  });
  servers.push(server);

  return {
    frames: frames,
    get protocols(): string[] {
      return protocols;
    },
    server: server,
    socket: (): Bun.ServerWebSocket<undefined> => {
      if (!socket) throw new Error("no browser connected");

      return socket;
    },
  };
}

async function waitFor(
  condition: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await Bun.sleep(10);
  }
}
