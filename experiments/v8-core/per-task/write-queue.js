/**
 * The outbound side of every task worker: requests pass straight through,
 * except the usage write, which goes out one at a time. Each finished run
 * writes its usage and its `run.completed` audit row in one Convex mutation
 * that moves the account's audit chain head. Today's core sends those from
 * its one ConvexHttpClient, which queues its mutations; separate task workers
 * each have their own client, so their usage writes race on that head and
 * Convex drops the losers once its retries run out. This worker is one
 * isolate shared by all task workers, the way a per-account write queue
 * service (or a Durable Object) would be. Other mutations stay parallel.
 */

const QUEUED = new Set(["usage:recordTaskUsage"]);

let tail = Promise.resolve();

export default {
  fetch: async function (request) {
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
    const send = () =>
      fetch(request.url, {
        method: "POST",
        headers: request.headers,
        body: body,
      });
    if (!QUEUED.has(path)) return send();
    const run = tail.then(async function () {
      const response = await send();
      const bytes = await response.arrayBuffer();

      return new Response(bytes, response);
    });
    tail = run.then(
      () => undefined,
      () => undefined,
    );

    return run;
  },
};
