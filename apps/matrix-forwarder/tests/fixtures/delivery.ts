/**
 * Runs the real account loop, `forwardRoomEvent` and `fanOut` against a fake
 * homeserver and a fake core webhook, then prints one JSON line of what each
 * saw. Its own process because the crypto module is stubbed with
 * `mock.module`, which would leak into every other test file, and
 * `account.test.ts` needs the real one. The events are plaintext, so the stub
 * only opens and closes, and this runs where the native binary is absent.
 *
 * `/sync` serves one customer message from `s1` and nothing new from `s2`, then
 * parks on `s3` until the account stops. argv[2] picks what core answers:
 * `transient` 503 then 200, `ratelimited` 429 then 200, `rejected` 404, `expired` 503 forever with the
 * clock jumping past the retry window, `restart` 503 until the account is
 * replaced by a fresh one on the same store, then 200.
 */
import { mock } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forwardRoomEvent } from "../../src/forward.ts";

const ACCESS_TOKEN = "syt_delivery";
const DEVICE_ID = "DEVICE1";
const MODE = process.argv[2];
const ROOM_ID = "!room:example.org";
const USER_ID = "@bot:example.org";
const storeDir = await mkdtemp(join(tmpdir(), "matrix-delivery-"));
const syncTokenPath = join(
  storeDir,
  createHash("sha256").update(`${USER_ID}|${DEVICE_ID}`).digest("hex"),
  "sync-token",
);
/** The status core answered each delivery with. */
const deliveries: number[] = [];
/** What `sync-token` held as each `/sync` arrived, "" before the first write. */
const tokensAtSync: string[] = [];
let parked = 0;
let webhookStatus =
  MODE === "rejected" ? 404 : MODE === "ratelimited" ? 429 : 503;

await mock.module("../../src/crypto.ts", (): object => ({
  RoomCrypto: {
    open: async (): Promise<object> => ({
      close: async (): Promise<void> => {},
      receiveSync: async (): Promise<void> => {},
    }),
  },
}));
const { MatrixAccount } = await import("../../src/account.ts");

const server = Bun.serve({
  port: 0,
  fetch: (request: Request): Response | Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname === "/v1/webhooks/a/matrix") {
      deliveries.push(webhookStatus);
      const status = webhookStatus;
      if (MODE === "transient" || MODE === "ratelimited") webhookStatus = 200;
      if (MODE === "expired") {
        const now = Date.now;
        Date.now = (): number => now() + 6 * 60_000;
      }

      return new Response(null, { status: status });
    }
    if (url.pathname.endsWith("/account/whoami")) {
      return Response.json({ device_id: DEVICE_ID, user_id: USER_ID });
    }
    if (url.pathname.endsWith("/joined_members")) {
      return Response.json({ joined: {} });
    }
    if (url.pathname.endsWith("/sync")) {
      tokensAtSync.push(storedToken());
      const since = url.searchParams.get("since");
      if (since === null) return Response.json({ next_batch: "s1" });
      if (since === "s1") {
        return Response.json({
          next_batch: "s2",
          rooms: {
            join: {
              [ROOM_ID]: {
                timeline: {
                  events: [
                    {
                      content: { body: "hello", msgtype: "m.text" },
                      event_id: "$customer",
                      origin_server_ts: 1,
                      sender: "@ada:example.org",
                      type: "m.room.message",
                    },
                  ],
                },
              },
            },
          },
        });
      }
      if (since === "s2") return Response.json({ next_batch: "s3" });
      parked += 1;

      return new Promise((resolve): void => {
        request.signal.addEventListener(
          "abort",
          (): void => resolve(new Response(null, { status: 499 })),
          { once: true },
        );
      });
    }

    return new Response(null, { status: 404 });
  },
});

try {
  const first = startAccount();
  await until((): boolean => parked === 1);
  if (MODE === "restart") {
    await first.stop();
    webhookStatus = 200;
    const second = startAccount();
    await until((): boolean => parked === 2);
    await second.stop();
  } else {
    await first.stop();
  }
  console.log(
    JSON.stringify({ deliveries: deliveries, tokensAtSync: tokensAtSync }),
  );
} finally {
  await server.stop(true);
  await rm(storeDir, { force: true, recursive: true });
}

function startAccount(): InstanceType<typeof MatrixAccount> {
  const account = new MatrixAccount({
    accessToken: ACCESS_TOKEN,
    apiUrl: `http://localhost:${server.port}`,
    onEvent: (event): Promise<boolean> =>
      forwardRoomEvent(event, ACCESS_TOKEN, [
        {
          agentId: "agent-1",
          agentName: "support",
          webhookUrl: `http://localhost:${server.port}/v1/webhooks/a/matrix`,
        },
      ]),
    storeDir: storeDir,
  });
  account.start();

  return account;
}

function storedToken(): string {
  try {
    return readFileSync(syncTokenPath, "utf8");
  } catch {
    return "";
  }
}

async function until(ready: () => boolean): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (!ready()) {
    if (performance.now() > deadline) throw new Error("the loop never parked");
    await Bun.sleep(5);
  }
}
