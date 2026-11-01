/**
 * The outbound side of every task worker: requests pass straight through,
 * except the usage write, which goes out one at a time. Each finished run
 * writes its usage and its `run.completed` audit row in one Convex mutation
 * that moves the account's audit chain head. Today's core sends those from
 * its one ConvexHttpClient, which queues its mutations; separate task workers
 * each have their own client, so their usage writes race on that head and
 * Convex drops the losers once its retries run out.
 *
 * The queue lives in one Durable Object (`WriteQueue`), the way a per-account
 * write queue would run on Workers: a plain worker cannot hold a promise chain
 * across requests (workerd cancels a request left waiting on another
 * request's promise as hung), a Durable Object can. Other mutations stay
 * parallel.
 */

const QUEUED = new Set(["usage:recordTaskUsage"]);

function send(url, headers, body) {
  return fetch(url, { method: "POST", headers: headers, body: body });
}

export class WriteQueue {
  constructor() {
    this.tail = Promise.resolve();
  }

  fetch(request) {
    const url = request.headers.get("x-queued-url");
    const headers = new Headers(request.headers);
    headers.delete("x-queued-url");
    const run = this.tail.then(async function () {
      const response = await send(url, headers, await request.text());

      return new Response(await response.arrayBuffer(), response);
    });
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );

    return run;
  }
}

export default {
  fetch: async function (request, env) {
    if (
      request.method !== "POST" ||
      !new URL(request.url).pathname.endsWith("/api/mutation")
    )
      return fetch(request);
    const body = await request.text();
    let path;
    try {
      path = JSON.parse(body).path;
    } catch {
      path = undefined;
    }
    if (!QUEUED.has(path)) return send(request.url, request.headers, body);
    const headers = new Headers(request.headers);
    headers.set("x-queued-url", request.url);

    return env.QUEUE.get(env.QUEUE.idFromName("usage")).fetch(
      "http://write-queue/",
      { method: "POST", headers: headers, body: body },
    );
  },
};
