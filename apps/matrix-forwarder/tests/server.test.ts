import { describe, expect, it } from "bun:test";
import type {
  MatrixSendRequest,
  MatrixTypingRequest,
} from "../../core/src/shared/matrix-wire.ts";
import { handleRequest } from "../src/server.ts";
import type {
  Forwarder,
  ForwarderAccount,
  ForwarderStatus,
} from "../src/supervisor.ts";

const STATUS: ForwarderStatus = { accounts: [], targets: 0 };

describe("the HTTP surface", () => {
  it("answers liveness before the config plane, readiness only after", async () => {
    const plane = forwarder({});
    const health = new Request("http://forwarder/healthz");
    const ready = new Request("http://forwarder/readyz");

    expect((await handleRequest(plane, false, health)).status).toBe(200);
    expect((await handleRequest(plane, false, ready)).status).toBe(503);
    expect((await handleRequest(plane, true, ready)).status).toBe(200);
  });

  it("refuses a token no managed account holds", async () => {
    const response = await handleRequest(
      forwarder({ "token-a": account() }),
      true,
      post(
        "/v1/send",
        { content: {}, roomId: "!r", type: "m.room.message" },
        "token-b",
      ),
    );

    expect(response.status).toBe(401);
  });

  it("sends through the token's account and returns the event id", async () => {
    const response = await handleRequest(
      forwarder({ "token-a": account() }),
      true,
      post(
        "/v1/send",
        { content: { body: "hi" }, roomId: "!r", type: "m.room.message" },
        "token-a",
      ),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ eventId: "$sent-m.room.message" });
  });

  it("sets typing and answers 204", async () => {
    const holder = account();
    const response = await handleRequest(
      forwarder({ "token-a": holder }),
      true,
      post("/v1/typing", { roomId: "!r", typing: true }, "token-a"),
    );

    expect(response.status).toBe(204);
    expect(holder.typing).toEqual([{ roomId: "!r", typing: true }]);
  });

  it("maps a homeserver failure to 502 and a bad body to 400", async () => {
    const plane = forwarder({ "token-a": account(true) });
    const failed = await handleRequest(
      plane,
      true,
      post(
        "/v1/send",
        { content: {}, roomId: "!r", type: "m.room.message" },
        "token-a",
      ),
    );
    const invalid = await handleRequest(
      plane,
      true,
      post("/v1/send", { roomId: "!r", type: "m.room.member" }, "token-a"),
    );

    expect(failed.status).toBe(502);
    expect(invalid.status).toBe(400);
  });
});

function account(failing = false): ForwarderAccount & {
  typing: MatrixTypingRequest[];
} {
  const typing: MatrixTypingRequest[] = [];

  return {
    send: async (request: MatrixSendRequest): Promise<string> => {
      if (failing) throw new Error("M_FORBIDDEN: not in room");

      return `$sent-${request.type}`;
    },
    setTyping: async (request: MatrixTypingRequest): Promise<void> => {
      typing.push(request);
    },
    start: (): void => {},
    state: "syncing",
    stop: async (): Promise<void> => {},
    typing: typing,
    userId: "@owner:example.org",
  };
}

function forwarder(
  accounts: Record<string, ForwarderAccount>,
): Pick<Forwarder, "account" | "status"> {
  return {
    account: (token: string): ForwarderAccount | undefined => accounts[token],
    status: (): ForwarderStatus => STATUS,
  };
}

function post(path: string, body: unknown, token?: string): Request {
  return new Request(`http://forwarder${path}`, {
    body: JSON.stringify(body),
    headers: token ? { "x-matrix-access-token": token } : {},
    method: "POST",
  });
}
