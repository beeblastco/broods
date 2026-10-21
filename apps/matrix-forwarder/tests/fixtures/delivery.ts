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
import type { MatrixForwardedEvent } from "../../../core/src/shared/matrix-wire.ts";
import type { ForwardTarget } from "../../../discord-forwarder/src/forward.ts";

/** One webhook answer, and what happens once it is sent. */
interface Answer {
  /** Moves the clock forward, as if that much time passed. */
  clockMs?: number;
  /** Moves this target's webhook to `/v1/webhooks/<moveTo>/matrix`: a new path, same agent. */
  moveTo?: string;
  status: number | "hang";
  /** Stops the account before it can try again. */
  stop?: boolean;
}

interface Script {
  /** What each target answers, in order; 200 once its list runs out. */
  answers: Record<string, Answer[]>;
  /** Body size of each customer message, to fill the outbox by bytes. */
  bodyBytes?: number;
  /** The first message arrives encrypted, and its room key one try late. */
  encryptedFirst?: boolean;
  events?: number;
  /** Starts a fresh account on the same store once the first stops, this much later. */
  restartAfterMs?: number;
  /**
   * How long the first account's webhook POST may hang before it fails; the
   * real 10 s when unset, and always after a restart.
   */
  webhookTimeoutMs?: number;
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
  locked: { answers: { a: [] }, encryptedFirst: true, events: 2 },
  moved: { answers: { a: [{ moveTo: "moved", status: 503 }] } },
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
  timeout: {
    answers: { a: [{ status: "hang", stop: true }] },
    restartAfterMs: SIX_MINUTES,
    webhookTimeoutMs: 200,
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
/** What each webhook path answered, in order. */
const deliveries: Record<string, Array<number | "hang">> = Object.fromEntries(
  Object.keys(script.answers).map((target): [string, []] => [target, []]),
);
/** The event id of every POST, in order, whatever the answer. */
const posted: string[] = [];
let decrypts = 0;
const realNow = Date.now;
let clockMs = 0;
Date.now = (): number => realNow() + clockMs;
let parked = 0;
let stopping: Promise<void> | null = null;

await mock.module("../../src/crypto.ts", (): object => ({
  RoomCrypto: {
    open: async (): Promise<object> => ({
      close: async (): Promise<void> => {},
      // The room key arrives after the first try.
      decrypt: async (_roomId: string, event: object): Promise<object> => {
        decrypts += 1;
        if (decrypts === 1) throw new Error("no room key yet");

        return { ...event, type: "m.room.message" };
      },
      receiveSync: async (): Promise<void> => {},
    }),
  },
}));
const { MatrixAccount } = await import("../../src/account.ts");

const server = Bun.serve({
  maxRequestBodySize: 256 * 1024 * 1024,
  port: 0,
  fetch: async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const target = /^\/v1\/webhooks\/(\w+)\/matrix$/.exec(url.pathname)?.[1];
    if (target !== undefined) {
      const body: MatrixForwardedEvent = JSON.parse(await request.text());
      posted.push(body.event.event_id);
      const answer = script.answers[target]?.shift() ?? { status: 200 };
      (deliveries[target] ??= []).push(answer.status);
      clockMs += answer.clockMs ?? 0;
      // A new object, as reconcile hands over: the account keeps the old one.
      const moving = targets.findIndex(
        (candidate): boolean => candidate.webhookUrl === url.href,
      );
      const movedFrom = targets[moving];
      if (answer.moveTo !== undefined && movedFrom !== undefined) {
        targets[moving] = {
          ...movedFrom,
          webhookUrl: `${url.origin}/v1/webhooks/${answer.moveTo}/matrix`,
        };
      }
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

// Only the first account's POST is scripted to hang, so only it gets the short timeout.
let account = startAccount(script.webhookTimeoutMs);
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
      posted: posted,
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

/** Starts an account; `webhookTimeoutMs` unset keeps the real 10 s. */
function startAccount(
  webhookTimeoutMs?: number,
): InstanceType<typeof MatrixAccount> {
  const started = new MatrixAccount({
    accessToken: ACCESS_TOKEN,
    apiUrl: `http://localhost:${server.port}`,
    storeDir: storeDir,
    targets: (): ForwardTarget[] => targets,
    webhookTimeoutMs: webhookTimeoutMs,
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
    // The stub decrypts by renaming the type, so the content stays readable.
    type:
      script.encryptedFirst && index === 0
        ? "m.room.encrypted"
        : "m.room.message",
  }));
}
