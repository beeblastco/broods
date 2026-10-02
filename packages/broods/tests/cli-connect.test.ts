/**
 * `broods connect` against a stubbed deployment: the browser redirect is
 * played by the test, the CLI keeps the PKCE verifier, state and nonce, and
 * only the code the redirect brought back goes to the deployment.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import type {
  BroodsAccountClient,
  Connection,
  ConnectionCode,
  ConnectionStart,
  ConnectionType,
} from "../src/account.ts";
import { connectInBrowser } from "../src/cli/connect.ts";

const realLog = console.log;

let starts: ConnectionStart[];
let codes: ConnectionCode[];
let hostId: string | undefined;
let redirectParams: Record<string, string>;

beforeEach(() => {
  starts = [];
  codes = [];
  hostId = "urn:uuid:host-1";
  redirectParams = { code: "code-1", client_id: "client-issued" };
  console.log = (): void => {};
});

afterEach(() => {
  console.log = realLog;
});

describe("connectInBrowser", () => {
  it("starts on the deployment and hands back only the code", async () => {
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

  it("sends no client or host id for a type the deployment's app runs", async () => {
    hostId = undefined;
    redirectParams = { code: "code-1" };

    await runConnect("google");

    expect(codes[0]).not.toHaveProperty("clientId");
    expect(codes[0]).not.toHaveProperty("hostId");
  });

  it("fails when the provider refuses the sign-in", async () => {
    redirectParams = { error: "access_denied" };

    const error = await runConnect("google").catch((caught: unknown) => caught);

    expect(String(error)).toContain("Sign-in failed: access_denied");
    expect(codes).toHaveLength(0);
  });
});

/** Plays the deployment and the browser: start answers a consent URL, the browser redirects back. */
async function runConnect(type: ConnectionType): Promise<Connection> {
  let redirectUri = "";
  let state = "";
  const client = {
    startConnection: async (
      _type: ConnectionType,
      start: ConnectionStart,
    ): Promise<{ authorizeUrl: string; hostId?: string }> => {
      starts.push(start);
      redirectUri = start.redirectUri;
      state = start.state;

      return {
        authorizeUrl: "https://provider.example/authorize",
        ...(hostId ? { hostId: hostId } : {}),
      };
    },
    connect: async (
      connectType: ConnectionType,
      code: ConnectionCode,
    ): Promise<Connection> => {
      codes.push(code);

      return {
        type: connectType,
        clientId: code.clientId ?? "deployment-client",
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
