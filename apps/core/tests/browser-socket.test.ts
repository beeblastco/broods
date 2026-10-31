/**
 * The browser side of a `scope: "user"` machine sandbox, against core's real
 * socket handler: what a `bbt_` ticket and an Origin let open, how a refresh
 * and a second socket of the same user behave, and that a run reaches only
 * its own end user's browser, with every out-of-bounds action refused before
 * it is sent and the sandbox kept out of what bash and the computer reach.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  AccountCipher,
  createWrappedAccountKey,
  type EncryptedBlob,
} from "@broods/convex/model/envelope";
import { sealBrowserTicket } from "@broods/convex/model/browserTicket";
import type { ToolExecuteFunction } from "ai";
import { compatibilityApprovalStatus } from "../src/harness/policy.ts";
import {
  runBrowserAction,
  type MachineSocketData,
} from "../src/harness/sandbox/machine-executor.ts";
import browserTool from "../src/harness/tools/browser.tool.ts";
import { resetAccountKeysForTests } from "../src/shared/convex/account-keys.ts";
import {
  hashAccountSecret,
  type AccountRecord,
} from "../src/shared/domain/accounts.ts";
import type { SandboxConfigRecord } from "../src/shared/domain/sandbox-config.ts";
import type { EndUser } from "../src/shared/domain/principal.ts";
import {
  MACHINE_CLOSE,
  MACHINE_WEBSOCKET_PATH,
  parseCoreFrame,
  type MachineBrowserFrame,
} from "../src/shared/machine-socket.ts";
import {
  resetStorageForTests,
  setStorageForTests,
  type MachineConnectionRecord,
  type Storage,
} from "../src/shared/storage.ts";
import {
  resolveAgentRuntime,
  type ResolvedAgentSandbox,
  type WorkspaceSandboxConfig,
} from "../src/shared/workspaces.ts";
import { closeOf, startMachineCore, waitFor } from "./helpers/machine.ts";

const ACCOUNT_ID = "acct_browser";
const ACCOUNT_SECRET = `bask_${crypto.randomUUID()}`;
const EXTENSION = "abcdefghijklmnopabcdefghijklmnop";
const KEK = "core-browser-kek";
const PROJECT_ID = "proj_browser";
const SANDBOX_ID = "sbx_browser";
const SECRET = "bsig_browser-test-secret";
const STAGE_ID = "stage_browser";
const ORIGIN = `chrome-extension://${EXTENSION}`;

/** What one fake extension did on its socket. */
interface FakeBrowser {
  frames: MachineBrowserFrame[];
  socket: WebSocket;
}

const servers: Bun.Server<MachineSocketData>[] = [];
const sockets: WebSocket[] = [];
let connected: MachineConnectionRecord[] = [];
let userTokenSecret: EncryptedBlob | undefined;

beforeEach(async (): Promise<void> => {
  process.env.ACCOUNT_CONFIG_ENCRYPTION_SECRET = KEK;
  const keys = [await createWrappedAccountKey(ACCOUNT_ID, [KEK])];
  resetAccountKeysForTests(async () => keys);
  userTokenSecret = await new AccountCipher(ACCOUNT_ID, [KEK], keys).encrypt(
    "agentDeployments:userTokenSecretCiphertext",
    { value: SECRET },
  );
  connected = [];
  setStorageForTests(browserStorage());
});

afterEach(async (): Promise<void> => {
  for (const socket of sockets.splice(0)) socket.close();
  for (const server of servers.splice(0)) await server.stop(true);
  resetStorageForTests();
  resetAccountKeysForTests();
});

describe("opening a browser socket", () => {
  test("a ticket from an allowed extension connects and is mirrored per user", async () => {
    const server = core();
    await connectBrowser(server, "alice");

    await waitFor((): boolean => connected.length === 1);
    expect(connected[0]).toMatchObject({
      accountId: ACCOUNT_ID,
      sandboxConfigId: SANDBOX_ID,
      subject: "alice",
      computer: false,
      mcp: [],
    });
  });

  test("a page, another extension or no Origin is refused with 4403", async () => {
    const server = core();
    for (const origin of [
      "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "https://evil.test",
      null,
    ]) {
      const socket = openBrowserSocket(
        server,
        await ticketFor("alice"),
        origin,
      );
      const closed = await closeOf(socket);

      expect(closed.code).toBe(MACHINE_CLOSE.originRefused.code);
      expect(closed.reason).toBe(MACHINE_CLOSE.originRefused.reason);
    }
  });

  test("a ticket opens one socket only, and a forged one opens none", async () => {
    const server = core();
    const ticket = await ticketFor("alice");
    await connectBrowser(server, "alice", ticket);

    const replay = await closeOf(openBrowserSocket(server, ticket));
    const forged = await closeOf(
      openBrowserSocket(
        server,
        await sealBrowserTicket(
          {
            userId: "alice",
            sandbox: "browser",
            expiresAt: Date.now() + 60_000,
            jti: crypto.randomUUID(),
          },
          "bsig_another-stage",
        ),
      ),
    );

    expect(replay.code).toBe(MACHINE_CLOSE.ticketRefused.code);
    expect(forged.code).toBe(MACHINE_CLOSE.ticketRefused.code);
  });

  test("a ticket for a sandbox that is not scope user is refused with 4404", async () => {
    const closed = await closeOf(
      openBrowserSocket(core(), await ticketFor("alice", "my-mac")),
    );

    expect(closed.code).toBe(MACHINE_CLOSE.unknownBrowser.code);
  });

  test("a daemon cannot claim a scope-user sandbox", async () => {
    const server = core();
    const socket = new WebSocket(
      `ws://127.0.0.1:${server.port}${MACHINE_WEBSOCKET_PATH}`,
      {
        headers: { authorization: `Bearer ${ACCOUNT_SECRET}` },
      } as unknown as string[],
    );
    sockets.push(socket);
    socket.onopen = (): void =>
      socket.send(
        JSON.stringify({ type: "hello", sandbox: "browser", instance: "d" }),
      );
    const closed = await closeOf(socket);

    expect(closed.code).toBe(MACHINE_CLOSE.unknownSandbox.code);
  });
});

describe("one user's sockets", () => {
  test("a refresh naming another user closes the socket with 4403", async () => {
    const server = core();
    const alice = await connectBrowser(server, "alice");
    const closing = closeOf(alice.socket);
    alice.socket.send(
      JSON.stringify({ type: "credential", token: await ticketFor("bob") }),
    );
    const closed = await closing;

    expect(closed.code).toBe(MACHINE_CLOSE.forbidden.code);
    expect(closed.reason).toBe(MACHINE_CLOSE.forbidden.reason);
  });

  test("a refresh for the same user is acknowledged with a new deadline", async () => {
    const server = core();
    const alice = await connectBrowser(server, "alice");
    const ready = new Promise<number | undefined>((resolve): void => {
      alice.socket.addEventListener("message", (event): void => {
        const frame = parseCoreFrame(event.data);
        if (frame?.type === "ready") resolve(frame.expiresInMs);
      });
    });
    alice.socket.send(
      JSON.stringify({
        type: "credential",
        token: await ticketFor("alice", "browser", 10 * 60_000),
      }),
    );

    expect(await ready).toBeGreaterThan(5 * 60_000);
  });

  test("the same user's newer socket replaces the older one", async () => {
    const server = core();
    const first = await connectBrowser(server, "alice");
    const firstClosed = closeOf(first.socket);
    const second = await connectBrowser(server, "alice", undefined, "page two");

    expect((await firstClosed).code).toBe(MACHINE_CLOSE.replaced.code);
    const reply = await runBrowserAction(browserConfig(), "alice", {
      action: "read_page",
    });
    expect(reply.text).toBe("page two");
    expect(first.frames).toHaveLength(0);
    expect(second.frames).toHaveLength(1);
  });
});

describe("routing a run's action", () => {
  test("user A's run reaches A's browser and never B's", async () => {
    const server = core();
    const alice = await connectBrowser(
      server,
      "alice",
      undefined,
      "alice page",
    );
    const bob = await connectBrowser(server, "bob", undefined, "bob page");

    const reply = await runBrowserAction(browserConfig(), "alice", {
      action: "read_page",
    });

    expect(reply.text).toBe("alice page");
    expect(alice.frames.map((frame) => frame.input)).toEqual([
      { action: "read_page" },
    ]);
    expect(bob.frames).toHaveLength(0);
    expect(
      await refusal(
        runBrowserAction(browserConfig(), "carol", { action: "read_page" }),
      ),
    ).toContain("is not connected");
  });

  test("navigate and upload_file outside https and allowedDomains are refused before sending", async () => {
    const server = core();
    const alice = await connectBrowser(server, "alice");
    const refused = [
      { action: "navigate" as const, url: "https://evil.test/" },
      { action: "navigate" as const, url: "http://example.com/" },
      { action: "navigate" as const, url: "javascript:alert(1)" },
      { action: "navigate" as const, url: "file:///etc/passwd" },
      {
        action: "upload_file" as const,
        ref: "r1",
        url: "https://evil.test/cv.pdf",
        name: "cv.pdf",
      },
      { action: "click" as const },
    ];
    for (const input of refused) {
      expect(
        await refusal(runBrowserAction(browserConfig(), "alice", input)),
      ).not.toBe("");
    }
    expect(alice.frames).toHaveLength(0);

    await runBrowserAction(browserConfig(), "alice", {
      action: "navigate",
      url: "https://app.example.com/inbox",
    });
    expect(alice.frames.map((frame) => frame.input)).toEqual([
      { action: "navigate", url: "https://app.example.com/inbox" },
    ]);
  });

  test("the browser tool refuses a run with no end user", async () => {
    const server = core();
    const alice = await connectBrowser(server, "alice");
    const run = (endUser: EndUser | undefined): Promise<unknown> =>
      Promise.resolve(
        (
          browserTool([browserSandbox()], () => endUser).browser
            ?.execute as ToolExecuteFunction<
            Record<string, unknown>,
            unknown,
            Record<string, unknown>
          >
        )(
          { action: "read_page" },
          { toolCallId: "call-1", messages: [], context: {} },
        ),
      );

    expect(await refusal(run(undefined))).toContain(
      "belongs to no signed-in person",
    );
    expect(alice.frames).toHaveLength(0);
    expect(await run({ userId: "alice" })).toEqual({
      type: "text",
      value: "page",
    });
  });

  test("an agent's scope-user machine resolves as a browser, never as a sandbox", async () => {
    const runtime = await resolveAgentRuntime(
      { sandboxes: [SANDBOX_ID, "sbx_mac"] },
      { accountId: ACCOUNT_ID, agentId: "agent_1" },
    );

    expect(runtime.sandboxes.map((entry) => entry.name)).toEqual(["my-mac"]);
    expect(runtime.browsers.map((entry) => entry.name)).toEqual(["browser"]);
  });

  test("looking is free and acting asks, unless the sandbox is in bypass", () => {
    const status = (
      action: string,
      permissionMode: "ask" | "bypass",
    ): unknown =>
      compatibilityApprovalStatus(
        "browser",
        { action: action },
        {
          configuredApprovals: new Map(),
          workspaces: [],
          browsers: [browserSandbox(permissionMode)],
        },
      );

    expect(status("read_page", "ask")).toBeUndefined();
    expect(status("screenshot", "ask")).toBeUndefined();
    expect(status("click", "ask")).toBe("user-approval");
    expect(status("navigate", "bypass")).toBeUndefined();
  });
});

/** The scope-user `browser` record and an ordinary `my-mac` beside it. */
function browserStorage(): Storage {
  const account: AccountRecord = {
    accountId: ACCOUNT_ID,
    username: "browsers",
    secretHash: hashAccountSecret(ACCOUNT_SECRET),
    status: "active",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  };
  const records: SandboxConfigRecord[] = [
    {
      accountId: ACCOUNT_ID,
      sandboxId: SANDBOX_ID,
      projectId: PROJECT_ID,
      stageId: STAGE_ID,
      name: "browser",
      config: browserConfig(),
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
    },
    {
      accountId: ACCOUNT_ID,
      sandboxId: "sbx_mac",
      projectId: PROJECT_ID,
      stageId: STAGE_ID,
      name: "my-mac",
      config: {
        provider: "machine",
        permissionMode: "ask",
        network: { mode: "allow-all" },
      },
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
    },
  ];

  return {
    accounts: {
      getById: async (accountId: string) =>
        accountId === ACCOUNT_ID ? account : null,
      getBySecretHash: async (hash: string) =>
        hash === account.secretHash ? account : null,
    },
    accountApiKeys: { resolveByKeyHash: async () => null },
    agentDeployments: {
      getByApiKeyHash: async () => null,
      getByStageIds: async (projectId: string, stageId: string) =>
        projectId === PROJECT_ID && stageId === STAGE_ID
          ? {
              accountId: ACCOUNT_ID,
              projectId: PROJECT_ID,
              stageId: STAGE_ID,
              endpointId: "stage-browser",
              projectSlug: "demo",
              stageSlug: "development",
              account: account,
              ...(userTokenSecret ? { userTokenSecret: userTokenSecret } : {}),
            }
          : null,
      touchLastUsed: async (): Promise<void> => {},
    },
    machineConnections: {
      connected: async (record: MachineConnectionRecord): Promise<void> => {
        connected.push(record);
      },
      disconnected: async (): Promise<void> => {},
      seen: async (): Promise<void> => {},
    },
    sandboxConfigs: {
      getById: async (_accountId: string, sandboxId: string) =>
        records.find((record) => record.sandboxId === sandboxId) ?? null,
      list: async () => records,
      removeAllForAccount: async () => 0,
    },
  } as unknown as Storage;
}

/** The executor config core builds for the `browser` record. */
function browserConfig(): WorkspaceSandboxConfig {
  return {
    provider: "machine",
    permissionMode: "ask",
    network: { mode: "allow-all" },
    options: {
      scope: "user",
      allowedExtensionIds: [EXTENSION],
      allowedDomains: ["example.com", "*.example.com"],
    },
    controlPlane: {
      accountId: ACCOUNT_ID,
      sandboxConfigId: SANDBOX_ID,
      name: "browser",
      specs: { vcpu: 0, memoryMb: 0, storageGb: 0 },
    },
  };
}

function browserSandbox(
  permissionMode: "ask" | "bypass" = "ask",
): ResolvedAgentSandbox {
  return {
    name: "browser",
    sandbox: { ...browserConfig(), permissionMode: permissionMode },
  };
}

/** A fake extension that answers every action with `page`. */
function connectBrowser(
  server: Bun.Server<MachineSocketData>,
  userId: string,
  ticket?: string,
  page = "page",
): Promise<FakeBrowser> {
  return (async (): Promise<FakeBrowser> => {
    const socket = openBrowserSocket(
      server,
      ticket ?? (await ticketFor(userId)),
    );
    const frames: MachineBrowserFrame[] = [];

    return await new Promise((resolve, reject): void => {
      let ready = false;
      socket.onopen = (): void =>
        socket.send(
          JSON.stringify({
            type: "hello",
            sandbox: "browser",
            instance: `ext-${userId}`,
            browser: true,
          }),
        );
      socket.onmessage = (event): void => {
        const frame = parseCoreFrame(event.data);
        if (frame?.type === "ready" && !ready) {
          ready = true;
          resolve({ frames: frames, socket: socket });
        }
        if (frame?.type === "browser") {
          frames.push(frame);
          socket.send(
            JSON.stringify({
              type: "browser-result",
              id: frame.id,
              text: page,
            }),
          );
        }
      };
      socket.onclose = (event): void => {
        if (!ready) reject(new Error(`closed ${event.code} ${event.reason}`));
      };
    });
  })();
}

function core(): Bun.Server<MachineSocketData> {
  const server = startMachineCore();
  servers.push(server);

  return server;
}

/** A socket to the stage's browser path; a null `origin` sends none. */
function openBrowserSocket(
  server: Bun.Server<MachineSocketData>,
  ticket: string,
  origin: string | null = ORIGIN,
): WebSocket {
  const socket = new WebSocket(
    `ws://127.0.0.1:${server.port}/v1/projects/${PROJECT_ID}/stages/${STAGE_ID}/browsers/ws`,
    {
      headers: {
        authorization: `Bearer ${ticket}`,
        ...(origin ? { origin: origin } : {}),
      },
    } as unknown as string[],
  );
  sockets.push(socket);

  return socket;
}

/** The message a call was refused with, or "" when it went through. */
async function refusal(call: Promise<unknown>): Promise<string> {
  return await call.then(
    (): string => "",
    (error: unknown): string =>
      error instanceof Error ? error.message : String(error),
  );
}

function ticketFor(
  userId: string,
  sandbox = "browser",
  ttlMs = 60_000,
): Promise<string> {
  return sealBrowserTicket(
    {
      userId: userId,
      sandbox: sandbox,
      expiresAt: Date.now() + ttlMs,
      jti: crypto.randomUUID(),
    },
    SECRET,
  );
}
