/**
 * Account-management sandbox lifecycle tests plus route-removal assertions for
 * sandbox/workspace CRUD that moved to the Convex config plane.
 */

import { afterEach, describe, expect, it, mock } from "bun:test";
import { coreRequest, responseJson } from "./helpers/http.ts";
import {
  resetStorageForTests,
  setStorageForTests,
} from "../src/shared/storage.ts";
import {
  normalizeCreateSandboxConfigInput,
  normalizeUpdateSandboxConfigInput,
  type SandboxConfig,
  type SandboxConfigRecord,
} from "../src/shared/domain/sandbox-config.ts";
import {
  normalizeCreateWorkspaceConfigInput,
  normalizeUpdateWorkspaceConfigInput,
  type WorkspaceConfigRecord,
} from "../src/shared/domain/workspace-config.ts";
import {
  openTerminalTicket,
  TERMINAL_WEBSOCKET_PATH,
} from "../src/shared/terminal-ticket.ts";

const ACCOUNT_ID = "acct_test";
const AUTH = { authorization: "Bearer fp_acct_test" };
const ORIGINAL_SERVICE_AUTH_SECRET = process.env.SERVICE_AUTH_SECRET;
const ORIGINAL_ADMIN_ACCOUNT_SECRET = process.env.ADMIN_ACCOUNT_SECRET;
const ORIGINAL_WORKDIR_URL = process.env.WORKDIR_URL;
const ORIGINAL_WORKDIR_API_KEY = process.env.WORKDIR_API_KEY;
const ORIGINAL_FILESYSTEM_BUCKET_NAME = process.env.FILESYSTEM_BUCKET_NAME;
const realFetch = globalThis.fetch;

interface FetchCall {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
}

let fetchCalls: FetchCall[] = [];
const fetchMock = mock(
  async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : undefined;
    fetchCalls.push({ method, path, body });

    if (method === "GET" && path === "/v1/sandboxes/sbx_handler") {
      return fetchResponse({
        id: "sbx_handler",
        state: "running",
        image: "base",
      });
    }
    if (method === "POST" && path === "/v1/sandboxes/sbx_handler/exec") {
      return fetchResponse({
        exit_code: 7,
        stdout: "stdout text",
        stderr: "stderr text",
      });
    }
    return fetchResponse({ error: { code: "not_found", message: path } }, 404);
  },
);

const getSandboxExternalIdMock = mock(
  async (_provider: string, _key: string) => "sbx_handler",
);
const claimSandboxInstanceMock = mock(async () => true);
const saveSandboxInstanceMock = mock(async () => {});
const deleteSandboxInstanceMock = mock(async () => {});

mock.module("../src/harness/sandbox/instance-store.ts", () => ({
  getSandboxExternalId: getSandboxExternalIdMock,
  claimSandboxInstance: claimSandboxInstanceMock,
  saveSandboxInstance: saveSandboxInstanceMock,
  deleteSandboxInstance: deleteSandboxInstanceMock,
}));

// The MicroVM terminal mint goes through the AWS SDK (GetMicrovm →
// CreateMicrovmShellAuthToken); answer that sequence and let a test force the
// shell-token failure seen on VMs launched without SHELL_INGRESS.
let microvmShellTokenError: string | null = null;
const microvmSendMock = mock(async (command: { _type?: string }) => {
  switch (command?._type) {
    case "GetMicrovm":
      return {
        microvmId: "sbx_handler",
        endpoint: "sbx-handler.lambda-microvm.eu-west-1.on.aws",
        state: "RUNNING",
      };
    case "CreateMicrovmShellAuthToken":
      if (microvmShellTokenError) throw new Error(microvmShellTokenError);
      return { authToken: { "X-aws-proxy-auth": "jwe-shell-token" } };
    default:
      return {};
  }
});
function microvmCommand(type: string) {
  return class {
    input: unknown;
    _type = type;
    constructor(input: unknown) {
      this.input = input;
    }
  };
}
mock.module("@aws-sdk/client-lambda-microvms", () => ({
  LambdaMicrovms: class {
    send = microvmSendMock;
  },
  RunMicrovmCommand: microvmCommand("RunMicrovm"),
  CreateMicrovmAuthTokenCommand: microvmCommand("CreateMicrovmAuthToken"),
  CreateMicrovmShellAuthTokenCommand: microvmCommand(
    "CreateMicrovmShellAuthToken",
  ),
  TerminateMicrovmCommand: microvmCommand("TerminateMicrovm"),
  GetMicrovmCommand: microvmCommand("GetMicrovm"),
  SuspendMicrovmCommand: microvmCommand("SuspendMicrovm"),
  ResumeMicrovmCommand: microvmCommand("ResumeMicrovm"),
}));

const { handler } = await import("../src/accounts/handler.ts");

afterEach(() => {
  if (ORIGINAL_SERVICE_AUTH_SECRET === undefined)
    delete process.env.SERVICE_AUTH_SECRET;
  else process.env.SERVICE_AUTH_SECRET = ORIGINAL_SERVICE_AUTH_SECRET;
  if (ORIGINAL_ADMIN_ACCOUNT_SECRET === undefined)
    delete process.env.ADMIN_ACCOUNT_SECRET;
  else process.env.ADMIN_ACCOUNT_SECRET = ORIGINAL_ADMIN_ACCOUNT_SECRET;
  if (ORIGINAL_WORKDIR_URL === undefined) delete process.env.WORKDIR_URL;
  else process.env.WORKDIR_URL = ORIGINAL_WORKDIR_URL;
  if (ORIGINAL_WORKDIR_API_KEY === undefined)
    delete process.env.WORKDIR_API_KEY;
  else process.env.WORKDIR_API_KEY = ORIGINAL_WORKDIR_API_KEY;
  if (ORIGINAL_FILESYSTEM_BUCKET_NAME === undefined)
    delete process.env.FILESYSTEM_BUCKET_NAME;
  else process.env.FILESYSTEM_BUCKET_NAME = ORIGINAL_FILESYSTEM_BUCKET_NAME;
  globalThis.fetch = realFetch;
  fetchCalls = [];
  fetchMock.mockClear();
  getSandboxExternalIdMock.mockClear();
  claimSandboxInstanceMock.mockClear();
  saveSandboxInstanceMock.mockClear();
  deleteSandboxInstanceMock.mockClear();
  microvmSendMock.mockClear();
  microvmShellTokenError = null;
  setStorageForTests(null);
  resetStorageForTests();
});

describe("account-manage sandbox endpoints", () => {
  it("no longer serves sandbox config CRUD routes (moved to the Convex config plane)", async () => {
    setStorageForTests(createFakeStorage());

    for (const [method, path] of [
      ["GET", "/v1/sandboxes"],
      ["POST", "/v1/sandboxes"],
      ["GET", "/v1/sandboxes/sb_1"],
      ["PATCH", "/v1/sandboxes/sb_1"],
      ["DELETE", "/v1/sandboxes/sb_1"],
    ] as const) {
      const response = await handler(
        createEvent(method, path, AUTH, method === "GET" ? undefined : {}),
      );
      expect(response.status).toBe(403);
      expect(await responseJson(response)).toEqual({ error: "Forbidden" });
    }

    process.env.ADMIN_ACCOUNT_SECRET = "admin-secret";
    const adminResponse = await handler(
      createEvent("GET", "/accounts/acct_test/sandboxes", {
        authorization: "Bearer admin-secret",
      }),
    );
    expect(adminResponse.status).toBe(404);
    expect(await responseJson(adminResponse)).toEqual({ error: "Not found" });
  });

  it("rejects unauthenticated sandbox requests", async () => {
    setStorageForTests(createFakeStorage());
    const response = await handler(createEvent("GET", "/v1/sandboxes"));
    expect(response.status).toBe(401);
  });

  it("rejects lifecycle actions for reservation keys not owned by the account/config", async () => {
    process.env.SERVICE_AUTH_SECRET = "service-secret";
    const created = await seedSandbox({
      provider: "sandbox",
      persistent: true,
      options: {
        workdirUrl: "https://workdir.example.com",
        apiKey: "tenant-key",
      },
    });

    const response = await handler(
      createEvent(
        "POST",
        `/v1/sandboxes/${created.sandboxId}/terminate`,
        { authorization: "Bearer service-secret", "x-account-id": ACCOUNT_ID },
        { reservationKey: "fs-not-owned-by-this-account" },
      ),
    );

    expect(response.status).toBe(403);
    expect(await responseJson(response)).toEqual({
      error: "reservationKey does not belong to this account or sandbox config",
    });
  });

  it("runs bounded lifecycle exec commands without marking non-zero exits as sandbox errors", async () => {
    process.env.SERVICE_AUTH_SECRET = "service-secret";
    process.env.WORKDIR_URL = "https://workdir.example.com";
    process.env.WORKDIR_API_KEY = "tenant-key";
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const reservationKey = "fs-0123456789abcdef0123456789abcdef01234567";
    const created = await seedSandbox({
      provider: "sandbox",
      persistent: true,
      options: { reservationKey },
    });

    const response = await handler(
      createEvent(
        "POST",
        `/v1/sandboxes/${created.sandboxId}/exec`,
        { authorization: "Bearer service-secret", "x-account-id": ACCOUNT_ID },
        {
          reservationKey,
          code: "exit 7",
          timeoutSeconds: 9999,
          outputLimitBytes: 999999,
        },
      ),
    );

    expect(response.status).toBe(200);
    expect(await responseJson(response)).toMatchObject({
      ok: false,
      runtime: "bash",
      exitCode: 7,
      stdout: "stdout text",
      stderr: "stderr text",
      truncated: false,
      provider: "sandbox",
    });
    expect(
      fetchCalls.find((call) => call.path === "/v1/sandboxes/sbx_handler/exec")
        ?.body,
    ).toMatchObject({
      cmd: "exit 7",
    });
  });

  it("mints a sealed terminal ticket that targets the reserved workdir PTY", async () => {
    process.env.SERVICE_AUTH_SECRET = "service-secret";
    process.env.WORKDIR_URL = "https://workdir.example.com";
    process.env.WORKDIR_API_KEY = "tenant-key";
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const reservationKey = "fs-0123456789abcdef0123456789abcdef01234567";
    const created = await seedSandbox({
      provider: "sandbox",
      persistent: true,
      options: { reservationKey },
    });

    const response = await handler(
      createEvent(
        "POST",
        `/v1/sandboxes/${created.sandboxId}/terminal`,
        { authorization: "Bearer service-secret", "x-account-id": ACCOUNT_ID },
        { reservationKey },
      ),
    );

    expect(response.status).toBe(200);
    const body = (await responseJson(response)) as {
      token: string;
      expiresAt: number;
      websocketPath: string;
    };
    expect(body.websocketPath).toBe(TERMINAL_WEBSOCKET_PATH);
    expect(body.expiresAt).toBeGreaterThan(Date.now());
    // The browser-held token is opaque; only a stage secret opens it.
    expect(body.token).not.toContain("tenant-key");
    expect(openTerminalTicket(body.token, "wrong-secret")).toBeNull();
    expect(openTerminalTicket(body.token, "service-secret")).toMatchObject({
      url: "wss://workdir.example.com/v1/sandboxes/sbx_handler/pty",
      authorization: "Bearer tenant-key",
      accountId: ACCOUNT_ID,
    });
  });

  it("mints a sealed terminal ticket that targets the MicroVM native shell", async () => {
    process.env.SERVICE_AUTH_SECRET = "service-secret";
    const reservationKey = "fs-0123456789abcdef0123456789abcdef01234567";
    const created = await seedSandbox({
      provider: "lambda",
      persistent: true,
      options: { reservationKey },
    });

    const response = await handler(
      createEvent(
        "POST",
        `/v1/sandboxes/${created.sandboxId}/terminal`,
        { authorization: "Bearer service-secret", "x-account-id": ACCOUNT_ID },
        { reservationKey },
      ),
    );

    expect(response.status).toBe(200);
    const body = (await responseJson(response)) as {
      token: string;
      expiresAt: number;
      websocketPath: string;
    };
    expect(body.websocketPath).toBe(TERMINAL_WEBSOCKET_PATH);
    // The gateway must send the shell token in the MicroVM proxy header, not
    // a bearer Authorization header.
    expect(openTerminalTicket(body.token, "service-secret")).toMatchObject({
      url: "wss://sbx-handler.lambda-microvm.eu-west-1.on.aws",
      authorization: "jwe-shell-token",
      authorizationHeader: "X-aws-proxy-auth",
      accountId: ACCOUNT_ID,
    });
  });

  it("maps MicroVM shell-token failures to a re-reserve hint", async () => {
    process.env.SERVICE_AUTH_SECRET = "service-secret";
    microvmShellTokenError =
      "MicroVM must have been run with the SHELL_INGRESS network connector attached";
    const reservationKey = "fs-0123456789abcdef0123456789abcdef01234567";
    const created = await seedSandbox({
      provider: "lambda",
      persistent: true,
      options: { reservationKey },
    });

    const response = await handler(
      createEvent(
        "POST",
        `/v1/sandboxes/${created.sandboxId}/terminal`,
        { authorization: "Bearer service-secret", "x-account-id": ACCOUNT_ID },
        { reservationKey },
      ),
    );

    expect(response.status).toBe(409);
    expect(
      String(((await responseJson(response)) as { error: string }).error),
    ).toContain("terminate and re-reserve");
  });

  it("refuses terminal tickets for providers without an in-guest PTY", async () => {
    process.env.SERVICE_AUTH_SECRET = "service-secret";
    const reservationKey = "fs-0123456789abcdef0123456789abcdef01234567";
    const created = await seedSandbox({
      provider: "e2b",
      persistent: true,
      network: { mode: "allow-all" },
      options: { reservationKey },
    });

    const response = await handler(
      createEvent(
        "POST",
        `/v1/sandboxes/${created.sandboxId}/terminal`,
        { authorization: "Bearer service-secret", "x-account-id": ACCOUNT_ID },
        { reservationKey },
      ),
    );

    expect(response.status).toBe(409);
    expect(
      String(((await responseJson(response)) as { error: string }).error),
    ).toContain("does not support a live terminal");
  });
});

describe("account-manage workspace endpoints", () => {
  it("no longer serves workspace config CRUD routes (moved to the Convex config plane)", async () => {
    setStorageForTests(createFakeStorage());

    for (const [method, path] of [
      ["GET", "/v1/workspaces"],
      ["POST", "/v1/workspaces"],
      ["GET", "/v1/workspaces/ws_1"],
      ["PATCH", "/v1/workspaces/ws_1"],
      ["DELETE", "/v1/workspaces/ws_1"],
    ] as const) {
      const response = await handler(
        createEvent(method, path, AUTH, method === "GET" ? undefined : {}),
      );
      expect(response.status).toBe(403);
      expect(await responseJson(response)).toEqual({ error: "Forbidden" });
    }

    process.env.ADMIN_ACCOUNT_SECRET = "admin-secret";
    const adminResponse = await handler(
      createEvent("GET", "/accounts/acct_test/workspaces", {
        authorization: "Bearer admin-secret",
      }),
    );
    expect(adminResponse.status).toBe(404);
    expect(await responseJson(adminResponse)).toEqual({ error: "Not found" });
  });

  it("no longer serves workspace file routes (moved to the Convex config plane)", async () => {
    process.env.SERVICE_AUTH_SECRET = "service-secret";
    setStorageForTests(createFakeStorage());

    const response = await handler(
      createEvent("GET", "/v1/workspaces/ws_1/files", {
        authorization: "Bearer service-secret",
        "x-account-id": ACCOUNT_ID,
      }),
    );

    expect(response.status).toBe(403);
    expect(await responseJson(response)).toEqual({ error: "Forbidden" });
  });
});

async function seedSandbox(
  config: SandboxConfig,
): Promise<SandboxConfigRecord> {
  const storage = createFakeStorage() as {
    sandboxConfigs: {
      create(accountId: string, input: unknown): Promise<SandboxConfigRecord>;
    };
  };
  setStorageForTests(storage as never);

  return await storage.sandboxConfigs.create(ACCOUNT_ID, {
    name: "persistent",
    config,
  });
}

function fetchResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
  } as unknown as Response;
}

function fakeAccount() {
  return {
    accountId: ACCOUNT_ID,
    username: "company-a",
    secretHash: "hash",
    status: "active" as const,
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
  };
}

/** In-memory sandbox/workspace stores driven by the real normalizers. */
function createFakeStorage() {
  const sandboxes = new Map<string, SandboxConfigRecord>();
  const workspaces = new Map<string, WorkspaceConfigRecord>();
  let counter = 0;
  const stamp = "2026-05-01T00:00:00.000Z";

  return {
    accounts: {
      async getById() {
        return fakeAccount();
      },
      async getBySecretHash() {
        return fakeAccount();
      },
      async list() {
        return [fakeAccount()];
      },
      async create() {
        return { account: fakeAccount(), secret: "fp_acct_fake" };
      },
      async update() {
        return fakeAccount();
      },
      async rotateSecret() {
        return { account: fakeAccount(), secret: "fp_acct_fake" };
      },
      async remove() {
        return true;
      },
    },
    agents: {} as never,
    agentDeployments: {
      async getByApiKeyHash() {
        return null;
      },
    },
    crons: {} as never,
    sandboxConfigs: {
      async getById(_accountId: string, id: string) {
        return sandboxes.get(id) ?? null;
      },
      async list() {
        return [...sandboxes.values()];
      },
      async create(accountId: string, input: unknown) {
        const n = normalizeCreateSandboxConfigInput(input as never);
        const sandboxId = `sb_${++counter}`;
        const record: SandboxConfigRecord = {
          accountId,
          sandboxId,
          name: n.name,
          ...(n.description ? { description: n.description } : {}),
          config: n.config,
          createdAt: stamp,
          updatedAt: stamp,
        };
        sandboxes.set(sandboxId, record);
        return record;
      },
      async update(_accountId: string, id: string, patch: unknown) {
        const existing = sandboxes.get(id);
        if (!existing) return null;
        const n = normalizeUpdateSandboxConfigInput(
          existing.config,
          patch as never,
        );
        const record: SandboxConfigRecord = {
          ...existing,
          config: n.config,
          updatedAt: stamp,
        };
        if (n.name !== undefined) record.name = n.name;
        if (n.description === null) delete record.description;
        else if (n.description !== undefined)
          record.description = n.description;
        sandboxes.set(id, record);
        return record;
      },
      async remove(_accountId: string, id: string) {
        return sandboxes.delete(id);
      },
      async removeAllForAccount() {
        const n = sandboxes.size;
        sandboxes.clear();
        return n;
      },
    },
    workspaceConfigs: {
      async getById(_accountId: string, id: string) {
        return workspaces.get(id) ?? null;
      },
      async list() {
        return [...workspaces.values()];
      },
      async create(accountId: string, input: unknown) {
        const n = normalizeCreateWorkspaceConfigInput(input as never);
        const workspaceId = `ws_${++counter}`;
        const record: WorkspaceConfigRecord = {
          accountId,
          workspaceId,
          name: n.name,
          ...(n.description ? { description: n.description } : {}),
          config: n.config,
          createdAt: stamp,
          updatedAt: stamp,
        };
        workspaces.set(workspaceId, record);
        return record;
      },
      async update(_accountId: string, id: string, patch: unknown) {
        const existing = workspaces.get(id);
        if (!existing) return null;
        const n = normalizeUpdateWorkspaceConfigInput(
          existing.config,
          patch as never,
        );
        const record: WorkspaceConfigRecord = {
          ...existing,
          config: n.config,
          updatedAt: stamp,
        };
        if (n.name !== undefined) record.name = n.name;
        if (n.description === null) delete record.description;
        else if (n.description !== undefined)
          record.description = n.description;
        workspaces.set(id, record);
        return record;
      },
      async remove(_accountId: string, id: string) {
        return workspaces.delete(id);
      },
      async removeAllForAccount() {
        const n = workspaces.size;
        workspaces.clear();
        return n;
      },
    },
  } as never;
}

function createEvent(
  method: string,
  rawPath: string,
  headers: Record<string, string> = {},
  body?: unknown,
): ReturnType<typeof coreRequest> {
  return coreRequest(method, rawPath, headers, body);
}
