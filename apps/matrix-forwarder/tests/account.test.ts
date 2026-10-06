/**
 * The whole loop against a fake homeserver: whoami, the device's real crypto
 * store on disk, `/sync`, a forwarded message, and a send back into the room.
 * Everything else in this folder stubs the account, so this is the only test
 * that runs `MatrixAccount` itself.
 *
 * It loads `@matrix-org/matrix-sdk-crypto-nodejs`, whose prebuilt `.node` is
 * absent wherever install ran with `--ignore-scripts` (CI does). The suite
 * skips itself there rather than failing.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MATRIX_BOT_MARKER,
  type MatrixForwardedEvent,
  type MatrixSendRequest,
} from "../../core/src/shared/matrix-wire.ts";
import type { RoomEvent } from "../src/matrix.ts";

const DEVICE_ID = "DEVICE1";
const ROOM_ID = "!room:example.org";
const USER_ID = "@bot:example.org";
const ADA_MESSAGE: RoomEvent = {
  content: { body: "morning", msgtype: "m.text" },
  event_id: "$event-1",
  origin_server_ts: 2,
  sender: "@ada:example.org",
  type: "m.room.message",
};
const DEFAULT_TIMELINE: RoomEvent[] = [
  {
    // The agent's own reply, which must not come back.
    content: {
      body: "earlier reply",
      [MATRIX_BOT_MARKER]: true,
      msgtype: "m.text",
    },
    event_id: "$event-0",
    origin_server_ts: 1,
    sender: USER_ID,
    type: "m.room.message",
  },
  ADA_MESSAGE,
];

interface Homeserver {
  apiUrl: string;
  memberLookups: number;
  /** Who `/joined_members` lists. Tests edit it to have someone leave. */
  members: Record<string, { display_name: string }>;
  sent: Array<{ body: unknown; path: string }>;
  stop: () => void;
  syncs: number;
}

interface HomeserverOptions {
  encrypted?: boolean;
  /** What the second sync, the first one the account forwards, serves. */
  timeline?: RoomEvent[];
  unknownToken?: boolean;
}

const cryptoAvailable = await nativeCryptoAvailable();
const temporaryDirs: string[] = [];

afterAll(async (): Promise<void> => {
  for (const dir of temporaryDirs) {
    await rm(dir, { force: true, recursive: true });
  }
});

describe.skipIf(!cryptoAvailable)("the account loop", () => {
  it("forwards a room message and sends a reply back", async () => {
    const { MatrixAccount } = await import("../src/account.ts");
    const homeserver = fakeHomeserver();
    const storeDir = await temporaryStore();
    const forwarded: MatrixForwardedEvent[] = [];
    const account = new MatrixAccount({
      accessToken: "syt_token",
      apiUrl: homeserver.apiUrl,
      onEvent: async (event: MatrixForwardedEvent): Promise<void> => {
        forwarded.push(event);
      },
      storeDir: storeDir,
    });

    account.start();
    try {
      await until((): boolean => forwarded.length > 0);

      expect(forwarded.map((event): string => event.event.event_id)).toEqual([
        "$event-1",
      ]);
      expect(forwarded[0]).toMatchObject({
        type: "MATRIX_ROOM_EVENT",
        encrypted: false,
        event: {
          content: { body: "morning", msgtype: "m.text" },
          event_id: "$event-1",
          sender: "@ada:example.org",
        },
        roomId: ROOM_ID,
        senderName: "Ada",
        userId: USER_ID,
      });
      expect(account.state).toBe("syncing");
      expect(account.userId).toBe(USER_ID);

      const eventId = await account.send({
        content: { body: "morning back", msgtype: "m.text" },
        roomId: ROOM_ID,
        type: "m.room.message",
      });

      expect(eventId).toBe("$sent-1");
      expect(homeserver.sent.at(-1)).toMatchObject({
        body: { body: "morning back" },
      });
      expect(homeserver.sent.at(-1)?.path).toContain(
        `/rooms/${encodeURIComponent(ROOM_ID)}/send/m.room.message/`,
      );
    } finally {
      await account.stop();
      homeserver.stop();
    }

    // The store outlives the account: its keys and its place in the timeline.
    expect(
      await readFile(join(storeDir, storePath(), "sync-token"), "utf8"),
    ).toBe("s2");
    expect(account.state).toBe("stopped");
  }, 20_000);

  it("stops for good when the homeserver rejects the token", async () => {
    const { MatrixAccount } = await import("../src/account.ts");
    const homeserver = fakeHomeserver({ unknownToken: true });
    const account = new MatrixAccount({
      accessToken: "syt_stale",
      apiUrl: homeserver.apiUrl,
      onEvent: async (): Promise<void> => {},
      storeDir: await temporaryStore(),
    });

    account.start();
    try {
      await until((): boolean => account.state === "failed");

      expect(homeserver.syncs).toBe(0);
    } finally {
      await account.stop();
      homeserver.stop();
    }
  }, 20_000);

  it("keeps the stored token where an undecryptable event is served again", async () => {
    const { MatrixAccount } = await import("../src/account.ts");
    const homeserver = fakeHomeserver({
      timeline: [
        {
          // No room key will ever arrive for this session.
          content: {
            algorithm: "m.megolm.v1.aes-sha2",
            ciphertext: "unknown",
            device_id: "OTHER",
            sender_key: "unknown",
            session_id: "unknown",
          },
          event_id: "$locked",
          origin_server_ts: 1,
          sender: "@ada:example.org",
          type: "m.room.encrypted",
        },
      ],
    });
    const storeDir = await temporaryStore();
    const forwarded: MatrixForwardedEvent[] = [];
    const account = new MatrixAccount({
      accessToken: "syt_token",
      apiUrl: homeserver.apiUrl,
      onEvent: async (event: MatrixForwardedEvent): Promise<void> => {
        forwarded.push(event);
      },
      storeDir: storeDir,
    });

    account.start();
    try {
      // A few syncs past the one that served it, each retrying it.
      await until((): boolean => homeserver.syncs >= 5);
    } finally {
      await account.stop();
      homeserver.stop();
    }

    expect(forwarded).toEqual([]);
    expect(
      await readFile(join(storeDir, storePath(), "sync-token"), "utf8"),
    ).toBe("s1");
  }, 20_000);

  it("stops between events on shutdown and keeps that sync to replay", async () => {
    const { MatrixAccount } = await import("../src/account.ts");
    const homeserver = fakeHomeserver({
      timeline: [ADA_MESSAGE, { ...ADA_MESSAGE, event_id: "$event-2" }],
    });
    const storeDir = await temporaryStore();
    const forwarded: string[] = [];
    const { promise: delivered, resolve: deliver } =
      Promise.withResolvers<void>();
    const account = new MatrixAccount({
      accessToken: "syt_token",
      apiUrl: homeserver.apiUrl,
      // The first delivery is still in flight when shutdown starts.
      onEvent: async (event: MatrixForwardedEvent): Promise<void> => {
        forwarded.push(event.event.event_id);
        await delivered;
      },
      storeDir: storeDir,
    });

    account.start();
    await until((): boolean => forwarded.length > 0);
    const stopped = account.stop();
    deliver();
    await stopped;
    homeserver.stop();

    expect(forwarded).toEqual(["$event-1"]);
    expect(
      await readFile(join(storeDir, storePath(), "sync-token"), "utf8"),
    ).toBe("s1");
  }, 20_000);

  it("asks who is in an encrypted room on every send", async () => {
    const { MatrixAccount } = await import("../src/account.ts");
    const homeserver = fakeHomeserver({ encrypted: true, timeline: [] });
    const account = new MatrixAccount({
      accessToken: "syt_token",
      apiUrl: homeserver.apiUrl,
      onEvent: async (): Promise<void> => {},
      storeDir: await temporaryStore(),
    });
    const reply: MatrixSendRequest = {
      content: { body: "hi", msgtype: "m.text" },
      roomId: ROOM_ID,
      type: "m.room.message",
    };

    account.start();
    try {
      await until((): boolean => homeserver.syncs >= 2);
      await account.send(reply);
      // Ada leaves. Her device list stays tracked while she shares another
      // room with the account, so no sync would say the room changed.
      delete homeserver.members["@ada:example.org"];
      await account.send(reply);

      expect(homeserver.memberLookups).toBe(2);
      expect(
        homeserver.sent.map((sent): string => sent.path.split("/")[4] ?? ""),
      ).toEqual(["m.room.encrypted", "m.room.encrypted"]);
    } finally {
      await account.stop();
      homeserver.stop();
    }
  }, 20_000);
});

/**
 * Answers the handful of endpoints the loop calls. `/sync` serves the timeline
 * on the second call, which is the first one the account forwards: the first
 * sync only fetches a token so the backlog is skipped.
 */
function fakeHomeserver(options: HomeserverOptions = {}): Homeserver {
  const state: Homeserver = {
    apiUrl: "",
    memberLookups: 0,
    members: {
      "@ada:example.org": { display_name: "Ada" },
      [USER_ID]: { display_name: "Georgi" },
    },
    sent: [],
    stop: (): void => {},
    syncs: 0,
  };
  const server = Bun.serve({
    port: 0,
    fetch: async (request: Request): Promise<Response> => {
      const url = new URL(request.url);
      const path = url.pathname.replace("/_matrix/client/v3", "");

      if (options.unknownToken) {
        return Response.json(
          { errcode: "M_UNKNOWN_TOKEN", error: "Invalid access token" },
          { status: 401 },
        );
      }
      if (path === "/account/whoami") {
        return Response.json({ device_id: DEVICE_ID, user_id: USER_ID });
      }
      if (path === "/sync") {
        state.syncs += 1;
        if (url.searchParams.get("since") === null) {
          return Response.json({ next_batch: "s1" });
        }
        if (state.syncs === 2) {
          return Response.json({
            next_batch: "s2",
            rooms: {
              join: {
                [ROOM_ID]: {
                  timeline: { events: options.timeline ?? DEFAULT_TIMELINE },
                },
              },
            },
          });
        }

        return Response.json({ next_batch: "s2" });
      }
      if (path.endsWith("/joined_members")) {
        state.memberLookups += 1;

        return Response.json({ joined: state.members });
      }
      if (path.includes("/state/m.room.encryption")) {
        return options.encrypted
          ? Response.json({ algorithm: "m.megolm.v1.aes-sha2" })
          : Response.json(
              { errcode: "M_NOT_FOUND", error: "Event not found" },
              { status: 404 },
            );
      }
      if (path.includes("/send/")) {
        state.sent.push({ body: await request.json(), path: path });

        return Response.json({ event_id: "$sent-1" });
      }
      // Every queried user answers with no devices, so there is no key to
      // share. A user left out would make the machine wait on them.
      if (path === "/keys/query") {
        const query: { device_keys: Record<string, string[]> } = JSON.parse(
          await request.text(),
        );
        const deviceKeys = Object.fromEntries(
          Object.keys(query.device_keys).map((userId): [string, object] => [
            userId,
            {},
          ]),
        );

        return Response.json({ device_keys: deviceKeys, failures: {} });
      }
      if (path === "/keys/claim") {
        return Response.json({ failures: {}, one_time_keys: {} });
      }
      // Whatever the OlmMachine uploads on its first sync.
      if (path.startsWith("/keys/")) {
        return Response.json({ one_time_key_counts: { signed_curve25519: 0 } });
      }
      if (path.startsWith("/sendToDevice/")) {
        return Response.json({});
      }

      return Response.json({ errcode: "M_UNRECOGNIZED" }, { status: 404 });
    },
  });
  state.apiUrl = `http://localhost:${server.port}`;
  state.stop = (): void => void server.stop(true);

  return state;
}

async function nativeCryptoAvailable(): Promise<boolean> {
  try {
    await import("@matrix-org/matrix-sdk-crypto-nodejs");

    return true;
  } catch {
    return false;
  }
}

/** The account's store folder name: the sha256 of its user and device. */
function storePath(): string {
  return new Bun.CryptoHasher("sha256")
    .update(`${USER_ID}|${DEVICE_ID}`)
    .digest("hex");
}

async function temporaryStore(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "matrix-forwarder-"));
  temporaryDirs.push(dir);

  return dir;
}

/** Polls `ready` every 50ms, failing the test rather than hanging forever. */
async function until(ready: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting on the loop");
    await Bun.sleep(50);
  }
}
