/**
 * The outbound side of every task worker: requests pass straight through,
 * except the two usage writes that land on one account-wide row. Each
 * finished run writes its usage and its `run.completed` audit row in one
 * Convex mutation that moves the account's audit chain head, and sandbox
 * commands add to the account's monthly meter. Today's core sends both from
 * its one ConvexHttpClient, which queues its usage writes; separate task
 * workers each have their own client, so their writes race on those rows and
 * Convex retries or drops the losers.
 *
 * So the writes go to one writer per account and kind (a Durable Object,
 * `WriteQueue`), which sends them as a group commit: whatever arrived while
 * the last write was in flight goes out as one batch mutation
 * (`usage:recordTaskUsages`, `account/budget:recordMany`) that applies each
 * write in order, each still deduplicated by its own task or write id. Every
 * caller gets the answer its own call would have got. A batch Convex refuses
 * is sent again one write at a time, so one bad write fails only its caller.
 * Broods itself does not carry the two batch mutations (they are in commit
 * 4631eaa), so against it every batch falls back to one write at a time.
 *
 * The batch is sent from a caller's own request, the first one waiting, which
 * waits for it; the next one waiting then leads. A plain worker cannot hold a
 * queue across requests (workerd cancels a request left waiting on another
 * request's promise as hung); a Durable Object can.
 */

const BATCHED = {
  "usage:recordTaskUsage": "usage:recordTaskUsages",
  "account/budget:record": "account/budget:recordMany",
};
// Well inside Convex's per-transaction write limits for these mutations.
const MAX_BATCH = 32;

function send(url, headers, body) {
  return fetch(url, { method: "POST", headers: headers, body: body });
}

function batchedPath(call) {
  return call && Object.hasOwn(BATCHED, call.path)
    ? BATCHED[call.path]
    : undefined;
}

export class WriteQueue {
  constructor() {
    this.waiting = [];
    this.busy = false;
  }

  async fetch(request) {
    const url = request.headers.get("x-queued-url");
    const headers = new Headers(request.headers);
    headers.delete("x-queued-url");
    const item = { body: await request.text(), response: undefined };
    const turn = new Promise(function (resolve) {
      item.wake = resolve;
    });
    this.waiting.push(item);
    if (this.busy) await turn;
    if (item.response) return item.response;
    // This caller leads: its own write is first in line.
    this.busy = true;
    try {
      await this.flush(url, headers, this.waiting.splice(0, MAX_BATCH));
    } finally {
      const next = this.waiting[0];
      if (next) next.wake();
      else this.busy = false;
    }

    return item.response;
  }

  async flush(url, headers, batch) {
    try {
      if (batch.length > 1 && (await this.sendBatch(url, headers, batch)))
        return;
      for (const item of batch) {
        const response = await send(url, headers, item.body);
        settle(item, new Response(await response.arrayBuffer(), response));
      }
    } catch (error) {
      // The caller gets a plain 502; the error itself stays in the log.
      console.error("write queue: Convex unreachable", error);
      for (const item of batch)
        if (!item.response)
          settle(
            item,
            new Response("write queue: Convex unreachable", { status: 502 }),
          );
    }
  }

  // True once every caller in `batch` has its answer from one batch call.
  async sendBatch(url, headers, batch) {
    const calls = batch.map(function (item) {
      return JSON.parse(item.body);
    });
    const response = await send(
      url,
      headers,
      JSON.stringify({
        path: batchedPath(calls[0]),
        format: calls[0].format,
        args: [
          {
            items: calls.map(function (call) {
              return call.args[0];
            }),
          },
        ],
      }),
    );
    if (!response.ok) return false;
    const reply = await response.json();
    if (
      reply.status !== "success" ||
      !Array.isArray(reply.value) ||
      reply.value.length !== batch.length
    )
      return false;
    batch.forEach(function (item, index) {
      settle(
        item,
        Response.json({
          status: "success",
          value: reply.value[index],
          logLines: [],
        }),
      );
    });

    return true;
  }
}

function settle(item, response) {
  item.response = response;
  item.wake();
}

export default {
  fetch: async function (request, env) {
    if (
      request.method !== "POST" ||
      !new URL(request.url).pathname.endsWith("/api/mutation")
    )
      return fetch(request);
    const body = await request.text();
    let call;
    try {
      call = JSON.parse(body);
    } catch {
      call = undefined;
    }
    if (!batchedPath(call)) return send(request.url, request.headers, body);
    const headers = new Headers(request.headers);
    headers.set("x-queued-url", request.url);
    const account = call.args?.[0]?.accountId ?? "";

    return env.QUEUE.get(
      env.QUEUE.idFromName(`${call.path}\u0000${account}`),
    ).fetch("http://write-queue/", {
      method: "POST",
      headers: headers,
      body: body,
    });
  },
};
