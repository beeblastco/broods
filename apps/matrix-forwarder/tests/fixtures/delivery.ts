/**
 * Runs the real account loop, its outbox, `forwardRoomEvent` and `fanOut`
 * against a fake homeserver and two fake core webhooks, then prints one JSON
 * line of what each saw. Its own process because the crypto module is stubbed
 * with `mock.module`, which would leak into every other test file, and
 * `account.test.ts` needs the real one. The events are plaintext, so the stub
 * only opens and closes, and this runs where the native binary is absent.
 *
 * `/sync` serves the customer messages from `s1` and nothing new from `s2`.
 * From `s3` it answers empty once the long-poll timeout the account asked for
 * runs out, and parks a full 30 second poll, which the account only asks for
 * once nothing in its outbox is waiting. argv[2] picks a `SCRIPTS` entry.
 */
import { Database } from "bun:sqlite";
import { mock } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ForwardTarget } from "../../../discord-forwarder/src/forward.ts";

/** One webhook answer, and what happens once it is sent. */
interface Answer {
  /** Moves the clock forward, as if that much time passed. */
  clockMs?: number;
  status: number | "hang";
  /** Stops the account before it can try again. */
  stop?: boolean;
}

interface Script {
  /** What each target answers, in order; 200 once its list runs out. */
  answers: Record<string, Answer[]>;
  /** Body size of each customer message, to fill the outbox by bytes. */
  bodyBytes?: number;
  events?: number;
  /** Starts a fresh account on the same store once the first stops, this much later. */
  restartAfterMs?: number;
}

const SIX_MINUTES = 6 * 60_000;
const SCRIPTS: Record<string, Script> = {
  bytes: {
    answers: { a: [{ status: 503, stop: true }] },
    bodyBytes: 26 * 1024 * 1024,
    events: 2,
  },
  expired: { answers: { a: [{ clockMs: 13 * 60 * 60_000, status: 503 }] } },
  healthy: { answers: { a: [], b: [{ status: 503 }] } },
  outage: {
    answers: {
      a: [
        { clockMs: SIX_MINUTES, status: 503 },
        { status: 503, stop: true },
      ],
    },
    restartAfterMs: SIX_MINUTES,
  },
  overflow: { answers: { a: [{ status: 503, stop: true }] }, events: 5_001 },
  ratelimited: { answers: { a: [{ status: 429 }] } },
  rejected: { answers: { a: [{ status: 404 }] } },
  timeout: {
    answers: { a: [{ status: "hang", stop: true }] },
    restartAfterMs: SIX_MINUTES,
  },
  transient: { answers: { a: [{ status: 503 }] } },
};

const ACCESS_TOKEN = "syt_delivery";
const DEVICE_ID = "DEVICE1";
const ROOM_ID = "!room:example.org";
const USER_ID = "@bot:example.org";
// An unknown mode answers nothing and fails every expectation.
const script: Script = SCRIPTS[process.argv[2] ?? ""] ?? { answers: {} };
const storeDir = await mkdtemp(join(tmpdir(), "matrix-delivery-"));
const storePath = join(
  storeDir,
  createHash("sha256").update(`${USER_ID}|${DEVICE_ID}`).digest("hex"),
);
/** What each target answered, in order. */
const deliveries: Record<string, Array<number | "hang">> = Object.fromEntries(
  Object.keys(script.answers).map((target): [string, []] => [target, []]),
);
const realNow = Date.now;
let clockMs = 0;
Date.now = (): number => realNow() + clockMs;
let parked = 0;
let stopping: Promise<void> | null = null;

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
  maxRequestBodySize: 256 * 1024 * 1024,
  port: 0,
  fetch: (request: Request): Response | Promise<Response> => {
    const url = new URL(request.url);
    const target = /^\/v1\/webhooks\/(\w+)\/matrix$/.exec(url.pathname)?.[1];
    if (target !== undefined) {
      const answer = script.answers[target]?.shift() ?? { status: 200 };
      deliveries[target]?.push(answer.status);
      clockMs += answer.clockMs ?? 0;
      // Aborted before the answer lands, so the account stops right after
      // recording it rather than racing on to its next try.
      if (answer.stop) stopping = account.stop();
      if (answer.status === "hang") return new Promise((): void => {});

      return new Response(null, { status: answer.status });
    }
    if (url.pathname.endsWith("/account/whoami")) {
      return Response.json({ device_id: DEVICE_ID, user_id: USER_ID });
    }
    if (url.pathname.endsWith("/joined_members")) {
      return Response.json({ joined: {} });
    }
    if (url.pathname.endsWith("/sync")) {
      const since = url.searchParams.get("since");
      if (since === null) return Response.json({ next_batch: "s1" });
      if (since === "s1") {
        return Response.json({
          next_batch: "s2",
          rooms: { join: { [ROOM_ID]: { timeline: { events: timeline() } } } },
        });
      }
      if (since === "s2") return Response.json({ next_batch: "s3" });
      const timeoutMs = Number(url.searchParams.get("timeout"));
      if (timeoutMs >= 30_000) parked += 1;

      return new Promise((resolve): void => {
        const timer = setTimeout(
          (): void => resolve(Response.json({ next_batch: "s3" })),
          timeoutMs >= 30_000 ? 2 ** 31 - 1 : timeoutMs,
        );
        request.signal.addEventListener(
          "abort",
          (): void => {
            clearTimeout(timer);
            resolve(new Response(null, { status: 499 }));
          },
          { once: true },
        );
      });
    }

    return new Response(null, { status: 404 });
  },
});
const targets: ForwardTarget[] = Object.keys(script.answers).map(
  (target): ForwardTarget => ({
    agentId: `agent-${target}`,
    agentName: target,
    webhookUrl: `http://localhost:${server.port}/v1/webhooks/${target}/matrix`,
  }),
);

let account = startAccount();
try {
  await settle();
  if (script.restartAfterMs !== undefined) {
    clockMs += script.restartAfterMs;
    account = startAccount();
    await settle();
  }
  console.log(
    JSON.stringify({
      deliveries: deliveries,
      held: heldEvents(),
      token: readFileSync(join(storePath, "sync-token"), "utf8"),
    }),
  );
} finally {
  await server.stop(true);
  await rm(storeDir, { force: true, recursive: true });
}

/** Rows left in the account's outbox. */
function heldEvents(): number {
  try {
    using db = new Database(join(storePath, "outbox.sqlite"), {
      readonly: true,
    });

    return (
      db
        .query<{ rows: number }, []>("SELECT COUNT(*) AS rows FROM outbox")
        .get()?.rows ?? 0
    );
  } catch {
    return 0;
  }
}

/** Waits until the account parks on a full poll or a scripted answer stops it, then stops it. */
async function settle(): Promise<void> {
  const parkedBefore = parked;
  stopping = null;
  const deadline = performance.now() + 25_000;
  while (parked === parkedBefore && stopping === null) {
    if (performance.now() > deadline) throw new Error("the loop never parked");
    await Bun.sleep(5);
  }
  await (stopping ?? account.stop());
}

function startAccount(): InstanceType<typeof MatrixAccount> {
  const started = new MatrixAccount({
    accessToken: ACCESS_TOKEN,
    apiUrl: `http://localhost:${server.port}`,
    storeDir: storeDir,
    targets: (): ForwardTarget[] => targets,
  });
  started.start();

  return started;
}

function timeline(): object[] {
  return Array.from({ length: script.events ?? 1 }, (_, index): object => ({
    content: {
      body: "x".repeat(script.bodyBytes ?? 5),
      msgtype: "m.text",
    },
    event_id: `$customer-${index}`,
    origin_server_ts: index,
    sender: "@ada:example.org",
    type: "m.room.message",
  }));
}
