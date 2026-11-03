/**
 * Runs before any other module. Under slimDirectConfig a task worker leaves the network directly
 * and gets the shared write queue (per-task/write-queue.js) as a WRITES binding instead of as its
 * globalOutbound, so only the usage and budget writes, which race on one account row, take the
 * extra hop through it. Without the binding (slimFastConfig) every fetch goes out as before.
 */

// ConvexHttpClient sends JSON.stringify({ path, format, args }), so the path leads the body.
const QUEUED = [
  '{"path":"usage:recordTaskUsage"',
  '{"path":"account/budget:record"',
];

let writes: { fetch: typeof fetch } | undefined;

/** The WRITES binding from the task worker's env, or undefined to send everything directly. */
export function setWriteQueue(
  binding: { fetch: typeof fetch } | undefined,
): void {
  writes = binding;
}

const direct = globalThis.fetch;
globalThis.fetch = function fetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const body = init?.body;
  if (
    writes !== undefined &&
    init?.method === "POST" &&
    typeof body === "string" &&
    QUEUED.some((prefix) => body.startsWith(prefix))
  )
    return writes.fetch(input, init);

  return direct(input, init);
} as typeof fetch;
