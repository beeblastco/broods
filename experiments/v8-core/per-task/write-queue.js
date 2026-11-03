/**
 * Outbound proxy for task workers. Usage, budget and sandbox-mirror writes race on one account's
 * usage rows, so each account gets one Durable Object (a plain worker cannot queue across
 * requests) that sends them in order, a batchable run as one batch mutation where Convex has one.
 */
const BATCHED = {
  "usage:recordTaskUsage": "usage:recordTaskUsages",
  "account/budget:record": "account/budget:recordMany",
};
// Queued but never batched: every sandbox command's mirror write adds its time to usageDays.
const QUEUED = new Set([...Object.keys(BATCHED), "sandbox/instances:upsert"]);
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

function queued(call) {
  return call !== undefined && QUEUED.has(call.path);
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
    const body = await request.text();
    const item = {
      body: body,
      path: JSON.parse(body).path,
      response: undefined,
    };
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
    // Runs of one kind keep the callers' order; only a batchable run of two or more goes as one.
    for (let start = 0; start < batch.length;) {
      let end = start + 1;
      while (end < batch.length && batch[end].path === batch[start].path) end++;
      await this.flushRun(url, headers, batch.slice(start, end));
      start = end;
    }
  }

  async flushRun(url, headers, run) {
    try {
      if (
        run.length > 1 &&
        BATCHED[run[0].path] &&
        (await this.sendBatch(url, headers, run))
      )
        return;
      for (const group of sameRow(run)) {
        // Only the last of a row's queued mirror writes goes: it meters the whole time since the
        // row's last write and carries the latest task, so every caller gets its answer.
        const response = await send(url, headers, group[group.length - 1].body);
        const bytes = await response.arrayBuffer();
        for (const item of group) settle(item, new Response(bytes, response));
      }
    } catch (error) {
      console.error("write queue: Convex unreachable", error);
      for (const item of run)
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

// Groups of one, except a run of mirror writes, grouped by sandbox row and machine in the order
// each group's last write arrived.
function sameRow(run) {
  if (run[0].path !== "sandbox/instances:upsert")
    return run.map(function (item) {
      return [item];
    });
  const groups = new Map();
  for (const item of run) {
    const args = JSON.parse(item.body).args[0];
    const key = `${args.reservationKey}\u0000${args.externalId}`;
    const group = groups.get(key) ?? [];
    groups.delete(key);
    group.push(item);
    groups.set(key, group);
  }

  return [...groups.values()];
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
    if (!queued(call)) return send(request.url, request.headers, body);
    const headers = new Headers(request.headers);
    headers.set("x-queued-url", request.url);
    const account = call.args?.[0]?.accountId ?? "";

    return env.QUEUE.get(env.QUEUE.idFromName(account)).fetch(
      "http://write-queue/",
      {
        method: "POST",
        headers: headers,
        body: body,
      },
    );
  },
};
