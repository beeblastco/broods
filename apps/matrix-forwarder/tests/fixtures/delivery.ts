// Own process: the `mock.module` crypto stub would leak into account.test.ts, which needs
// the real one. The stub also lets this run where the native binary is absent.
import { Database } from "bun:sqlite";
import { mock } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MatrixForwardedEvent } from "../../../core/src/shared/matrix-wire.ts";
import type { ForwardTarget } from "../../../discord-forwarder/src/forward.ts";

interface Answer {
  clockMs?: number;
  moveTo?: string;
  status: number | "hang";
  stop?: boolean;
}

interface Script {
  answers: Record<string, Answer[]>;
  bodyBytes?: number;
  encryptedFirst?: boolean;
  events?: number;
  restartAfterMs?: number;
  /** Applies to the first account only; unset, and after a restart, it is the real 10 s. */
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
const script: Script = SCRIPTS[process.argv[2] ?? ""] ?? { answers: {} };
const storeDir = await mkdtemp(join(tmpdir(), "matrix-delivery-"));
const storePath = join(
  storeDir,
  createHash("sha256").update(`${USER_ID}|${DEVICE_ID}`).digest("hex"),
);
const deliveries: Record<string, Array<number | "hang">> = Object.fromEntries(
  Object.keys(script.answers).map((target): [string, []] => [target, []]),
);
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
      // Stopped before the answer lands, so the account records it and does not try again.
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

// Settled = parked on a full 30 s poll, which the account only asks for with an empty outbox.
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
    type:
      script.encryptedFirst && index === 0
        ? "m.room.encrypted"
        : "m.room.message",
  }));
}
