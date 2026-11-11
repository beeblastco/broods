import { afterEach, beforeEach, describe, expect, it, test } from "bun:test";
import { createHash } from "node:crypto";
import type {
  BroodsAccountClient,
  Connection,
  ConnectionCode,
  ConnectionStart,
  ConnectionStartResult,
  ConnectionType,
} from "../src/account.ts";
import { connectInBrowser } from "../src/cli/connect.ts";

const realLog = console.log;

let starts: ConnectionStart[];
let codes: ConnectionCode[];
let redirectParams: Record<string, string>;

beforeEach((): void => {
  starts = [];
  codes = [];
  redirectParams = { code: "code-1", client_id: "client-issued" };
  console.log = (): void => {};
});

afterEach((): void => {
  console.log = realLog;
});

describe("connectInBrowser", (): void => {
  it("starts on the deployment and hands back only the code", async (): Promise<void> => {
    const connection = await runConnect("chatgpt");

    const start = starts[0];
    const code = codes[0];
    expect(start?.redirectUri).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/,
    );
    expect(start?.codeChallenge).toBe(
      createHash("sha256")
        .update(code?.codeVerifier ?? "")
        .digest("base64url"),
    );
    expect(code).toMatchObject({
      code: "code-1",
      redirectUri: start?.redirectUri,
      nonce: start?.nonce,
      clientId: "client-issued",
      hostId: "urn:uuid:host-1",
    });
    expect(connection.type).toBe("chatgpt");
  });

  it("signs in again on the started client when the redirect omits it", async (): Promise<void> => {
    redirectParams = { code: "code-1" };

    await runConnect("chatgpt");

    expect(codes[0]?.clientId).toBe("client-saved");
  });

  it("fails when the provider refuses the sign-in", async (): Promise<void> => {
    redirectParams = { error: "access_denied" };

    const error = await runConnect("chatgpt").catch(
      (caught: unknown): unknown => caught,
    );

    expect(String(error)).toContain("Sign-in failed: access_denied");
    expect(codes).toHaveLength(0);
  });
});

test("connect lists a connection type this CLI does not know", async (): Promise<void> => {
  const server = Bun.serve({
    port: 0,
    fetch: (): Response =>
      Response.json({
        connections: [{ type: "future-plan", clientId: "client-1" }],
      }),
  });
  try {
    const proc = Bun.spawn({
      cmd: [
        process.execPath,
        new URL("../src/cli/index.ts", import.meta.url).pathname,
        "connect",
        "--base-url",
        `http://127.0.0.1:${server.port}`,
      ],
      stdout: "pipe",
      stderr: "pipe",
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        BROODS_ACCOUNT_SECRET: "bsa_test",
      },
    });
    const [exitCode, stdout] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/future-plan +client-1/);
  } finally {
    await server.stop(true);
  }
});
test("connect keeps the method, path and status when the error body is not JSON", async (): Promise<void> => {
  const server = Bun.serve({
    port: 0,
    fetch: (): Response => new Response("Bad Gateway", { status: 502 }),
  });
  try {
    const proc = Bun.spawn({
      cmd: [
        process.execPath,
        new URL("../src/cli/index.ts", import.meta.url).pathname,
        "connect",
        "chatgpt",
        "--base-url",
        `http://127.0.0.1:${server.port}`,
      ],
      stdout: "pipe",
      stderr: "pipe",
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        BROODS_ACCOUNT_SECRET: "bsa_test",
      },
    });
    const [exitCode, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text(),
    ]);

    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/POST \/v1\/\S+ failed with 502: Bad Gateway/);
  } finally {
    await server.stop(true);
  }
});

async function runConnect(type: ConnectionType): Promise<Connection> {
  let redirectUri = "";
  let state = "";
  const client = {
    startConnection: async (
      _type: ConnectionType,
      start: ConnectionStart,
    ): Promise<ConnectionStartResult> => {
      starts.push(start);
      redirectUri = start.redirectUri;
      state = start.state;

      return {
        authorizeUrl: "https://provider.example/authorize",
        clientId: "client-saved",
        hostId: "urn:uuid:host-1",
      };
    },
    connect: async (
      connectType: ConnectionType,
      code: ConnectionCode,
    ): Promise<Connection> => {
      codes.push(code);

      return {
        type: connectType,
        clientId: code.clientId,
        hostId: code.hostId,
        scopes: [],
        expiresAt: "2026-10-02T12:00:00.000Z",
        updatedAt: "2026-10-02T11:00:00.000Z",
      };
    },
  } as Pick<
    BroodsAccountClient,
    "startConnection" | "connect"
  > as BroodsAccountClient;
  const open = (): void => {
    const callback = new URL(redirectUri);
    callback.search = new URLSearchParams({
      ...redirectParams,
      state: state,
    }).toString();
    void fetch(callback);
  };

  return await connectInBrowser(client, type, open);
}
